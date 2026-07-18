from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import hashlib
import json
import mimetypes
import os
import posixpath
import shutil
import sys
import threading
import uuid

from fastapi import FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from PIL import UnidentifiedImageError

from .cleanup import dated_quarantine_dir, restore_quarantine as restore_quarantine_files
from .grouping import GroupableImage, group_images
from .hashing import fingerprint, similarity_percent
from .manifest import Manifest, utc_now
from .quality import choose_keep, quality_score
from .scanner import ImageFile, ScanFolderResult, ScanStats, scan_folder as _scan_folder, scan_folder_with_stats
from .thumbs import make_thumbnail

scan_folder = _scan_folder

DEFAULT_SETTINGS = {
    "threshold": 90,
    "recursive": True,
    "extensions": ["jpg", "jpeg", "png", "heic", "webp"],
    "cleanup_mode": "trash",
    "scan_folders": [],
    "scan_folders_updated_at": None,
    "include_online_only": False,
}


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"
    phase: str = "scanning"
    done: int = 0
    total: int = 0
    summary: dict[str, object] | None = None
    error: str | None = None
    current_path: str | None = None
    skipped: dict[str, int] = field(default_factory=dict)
    cancel_requested: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict[str, object]:
        with self.lock:
            key = "scan_id" if self.kind == "scan" else "job_id"
            payload = {
                key: self.id,
                "status": self.status,
                "phase": self.phase,
                "done": self.done,
                "total": self.total,
                "summary": self.summary,
                "error": self.error,
            }
            if self.kind == "scan":
                payload["cancellable"] = self.status in {"queued", "running"}
                payload["eta_sec"] = None
                payload["current_path"] = self.current_path
                payload["skipped"] = dict(self.skipped)
            return payload

    def set_progress(
        self,
        done: int,
        total: int,
        phase: str,
        *,
        current_path: str | None = None,
        skipped: dict[str, int] | None = None,
    ) -> None:
        with self.lock:
            if self.status in {"cancelled", "done", "error"}:
                return
            if self.status != "cancel_requested":
                self.status = "running"
            self.done = int(done)
            self.total = int(total)
            self.phase = phase
            if current_path is not None:
                self.current_path = current_path
            if skipped is not None:
                self.skipped = dict(skipped)


def create_app(data_dir: str | Path, token: str) -> FastAPI:
    data_path = Path(data_dir).expanduser().resolve()
    data_path.mkdir(parents=True, exist_ok=True)
    db_path = data_path / "manifest.db"
    thumbs_dir = data_path / "thumbs"
    cache_dir = data_path / "cache"
    settings_path = data_path / "settings.json"
    jobs: dict[str, Job] = {}
    jobs_lock = threading.Lock()

    Manifest(db_path, run_migrations=True).close()
    print(f"manifest migrations complete db_path={db_path}", file=sys.stderr, flush=True)

    app = FastAPI(title="Photo Dedup Desktop Sidecar API", version="0.1.0")

    def open_manifest() -> Manifest:
        return Manifest(db_path, run_migrations=False)

    @app.middleware("http")
    async def token_auth(request: Request, call_next):
        debug_requests = os.environ.get("PHOTODEDUP_LOG_LEVEL", "").lower() == "debug"
        supplied = request.headers.get("X-Api-Token") or request.headers.get("X-PD-Token")
        if request.url.path != "/healthz" and supplied != token:
            if debug_requests:
                print(f"{request.method} {request.url.path} 401", file=sys.stderr, flush=True)
            return _error_response(401, "unauthorized", "Missing or invalid token")
        response = await call_next(request)
        if debug_requests:
            print(f"{request.method} {request.url.path} {response.status_code}", file=sys.stderr, flush=True)
        return response

    @app.get("/healthz", operation_id="getHealthz")
    def get_healthz() -> dict[str, object]:
        manifest = open_manifest()
        try:
            images = int(manifest.conn.execute("SELECT COUNT(*) FROM images").fetchone()[0])
            groups = int(manifest.conn.execute("SELECT COUNT(*) FROM groups").fetchone()[0])
        finally:
            manifest.close()
        thumbs_dir.mkdir(parents=True, exist_ok=True)
        return {
            "status": "ok",
            "version": "0.1.0",
            "db_path": str(db_path),
            "thumbs_dir": str(thumbs_dir),
            "images": images,
            "groups": groups,
        }

    @app.post("/scan", status_code=202, operation_id="startScan")
    def start_scan(payload: dict[str, object]) -> dict[str, object]:
        roots = payload.get("roots")
        if not isinstance(roots, list) or not roots or not all(isinstance(root, str) for root in roots):
            raise _http_error(400, "bad_request", "roots must be a non-empty string array")
        settings = _load_settings(settings_path)
        threshold = int(payload.get("threshold", settings["threshold"]))
        if threshold < 0 or threshold > 100:
            raise _http_error(400, "bad_request", "threshold must be between 0 and 100")
        _save_settings(settings_path, {**settings, "threshold": threshold, "scan_folders": roots, "scan_folders_updated_at": utc_now()})
        with jobs_lock:
            for existing in jobs.values():
                if existing.kind == "scan" and existing.status in {"queued", "running", "cancel_requested"}:
                    with existing.lock:
                        existing.cancel_requested = True
                        existing.status = "cancelled"
                        existing.phase = "done"
            job = Job(id=f"scan_{uuid.uuid4().hex}", kind="scan")
            jobs[job.id] = job
        include_online_only = bool(settings.get("include_online_only", False))
        thread = threading.Thread(
            target=_run_scan_job,
            args=(job, db_path, thumbs_dir, cache_dir, [Path(root) for root in roots], threshold, include_online_only),
            daemon=True,
        )
        thread.start()
        return {"scan_id": job.id, "status": job.status}

    @app.get("/scan/{id}", operation_id="getScan")
    def get_scan(id: str) -> dict[str, object]:
        job = _get_job(jobs, id, "scan")
        return job.snapshot()

    @app.post("/scan/{id}/cancel", status_code=202, operation_id="cancelScan")
    def cancel_scan(id: str) -> dict[str, object]:
        job = _get_job(jobs, id, "scan")
        with job.lock:
            if job.status not in {"queued", "running"}:
                raise _http_error(409, "conflict", "scan is not cancellable")
            job.cancel_requested = True
            job.status = "cancel_requested"
        return {"scan_id": id, "status": "cancel_requested"}

    @app.get("/groups", operation_id="listGroups")
    def list_groups(
        limit: int = 50,
        cursor: str | None = None,
        sort: str = "reclaimable_bytes",
        status: str = "unresolved",
        include: str | None = None,
        min_size: int | None = None,
        max_size: int | None = None,
        min_similarity: float | None = None,
        roots: list[str] | None = Query(None),
    ) -> dict[str, object]:
        if limit < 1 or limit > 10000:
            raise _http_error(400, "bad_request", "limit must be between 1 and 10000")
        if include not in {None, "details"}:
            raise _http_error(400, "bad_request", "include must be details when provided")
        offset = int(cursor or 0)
        manifest = open_manifest()
        try:
            if roots:
                candidates = _list_groups(manifest, -1, 0, sort, status, min_size, max_size, min_similarity)
                in_scope_counts = _in_scope_counts(manifest, [int(group["id"]) for group in candidates], roots)
                filtered = []
                for group in candidates:
                    in_scope_count = in_scope_counts.get(int(group["id"]), 0)
                    if in_scope_count >= 2:
                        filtered.append({**group, "member_count": in_scope_count})
                items = filtered[offset : offset + limit]
                next_cursor = str(offset + limit) if offset + limit < len(filtered) else None
                if include == "details":
                    items = _details_for_group_items(manifest, items, roots)
                return {"items": items, "next_cursor": next_cursor, "total_estimate": len(filtered)}
            items = _list_groups(manifest, limit, offset, sort, status, min_size, max_size, min_similarity)
            next_cursor = str(offset + limit) if len(items) == limit else None
            total = _count_list_groups(manifest, status, min_size, max_size, min_similarity)
            if include == "details":
                items = _details_for_group_items(manifest, items, None)
            return {"items": items, "next_cursor": next_cursor, "total_estimate": int(total)}
        finally:
            manifest.close()

    @app.get("/groups/snapshot", operation_id="getGroupsSnapshot")
    def get_groups_snapshot(roots: list[str] | None = Query(None)) -> dict[str, object]:
        requested_roots = roots or []
        snapshot_path = _snapshot_path(cache_dir, requested_roots)
        if not snapshot_path.exists():
            raise _http_error(404, "not_found", "group snapshot not found")
        try:
            payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            _discard_snapshot(snapshot_path)
            raise _http_error(404, "not_found", "group snapshot invalid") from exc
        if not _snapshot_roots_match(payload, requested_roots):
            _discard_snapshot(snapshot_path)
            raise _http_error(404, "not_found", "group snapshot roots mismatch")
        print(f"group snapshot loaded path={snapshot_path}", file=sys.stderr, flush=True)
        return payload

    @app.get("/groups/{id}", operation_id="getGroup")
    def get_group(id: str, roots: list[str] | None = Query(None)) -> dict[str, object]:
        manifest = open_manifest()
        try:
            return _group_detail(manifest, int(id), roots)
        finally:
            manifest.close()

    @app.patch("/images/{id}", operation_id="updateImage")
    def update_image(id: str, payload: dict[str, object]) -> dict[str, object]:
        mark = payload.get("mark")
        if mark not in {"keep", "delete", "none"}:
            raise _http_error(400, "bad_request", "mark must be keep, delete, or none")
        manifest = open_manifest()
        try:
            row = manifest.conn.execute("SELECT * FROM images WHERE id = ?", (int(id),)).fetchone()
            if row is None:
                raise _http_error(404, "not_found", "image not found")
            group_id = int(row["group_id"]) if row["group_id"] is not None else None
            manifest.conn.execute(
                "UPDATE images SET mark = ?, is_keep = ? WHERE id = ?",
                (mark, 1 if mark == "keep" else 0, int(id)),
            )
            manifest.conn.commit()
            if group_id is not None:
                _mark_group_completed(cache_dir, group_id)
            updated = manifest.conn.execute("SELECT i.*, g.keep_image_id FROM images i LEFT JOIN groups g ON g.group_id = i.group_id WHERE i.id = ?", (int(id),)).fetchone()
            return {"image": _image_payload(updated)}
        finally:
            manifest.close()

    @app.post("/groups/{id}/action", operation_id="applyGroupAction")
    def apply_group_action(id: str, payload: dict[str, object]) -> dict[str, object]:
        action = payload.get("action")
        if action not in {"apply_recommended", "keep_all", "delete_all"}:
            raise _http_error(400, "bad_request", "invalid action")
        manifest = open_manifest()
        try:
            group_id = int(id)
            detail = _group_detail(manifest, group_id)
            keep_id = detail["group"]["recommended_keep_image_id"]
            manual_keep_ids = {
                int(image["id"])
                for image in detail["images"]
                if image.get("mark") == "keep"
            } if action == "apply_recommended" else set()
            for image in detail["images"]:
                if action == "apply_recommended":
                    if manual_keep_ids:
                        mark = "keep" if int(image["id"]) in manual_keep_ids else "delete"
                    else:
                        mark = "keep" if image["id"] == keep_id else "delete"
                elif action == "keep_all":
                    mark = "keep"
                else:
                    mark = "delete"
                manifest.conn.execute("UPDATE images SET mark = ?, is_keep = ? WHERE id = ?", (mark, 1 if mark == "keep" else 0, image["id"]))
            if action == "keep_all":
                manifest.conn.execute("UPDATE images SET keep_all = 1 WHERE group_id = ?", (group_id,))
                manifest.conn.execute("UPDATE groups SET keep_all = 1 WHERE group_id = ?", (group_id,))
                resolved_at = utc_now()
                manifest.record_evaluated_group(group_id, evaluated_at=resolved_at)
                manifest.mark_group_resolved(group_id, resolved_at=resolved_at)
            manifest.conn.commit()
            _mark_group_completed(cache_dir, group_id)
            updated = _group_detail(manifest, group_id)
            return {"group": updated["group"], "images": updated["images"]}
        finally:
            manifest.close()

    @app.post("/apply", status_code=202, operation_id="applyMarkedDeletes")
    def apply_marked_deletes(payload: dict[str, object]) -> dict[str, object]:
        mode = payload.get("mode", "trash")
        if mode not in {"trash", "permanent"}:
            raise _http_error(400, "bad_request", "mode must be trash or permanent")
        group_ids = _parse_group_ids(payload.get("group_ids"))
        job = Job(id=f"cleanup_{uuid.uuid4().hex}", kind="cleanup", phase="planning")
        with jobs_lock:
            jobs[job.id] = job
        threading.Thread(target=_run_cleanup_job, args=(job, db_path, mode, group_ids), daemon=True).start()
        targets = _count_delete_marks(db_path, group_ids)
        return {"job_id": job.id, "status": job.status, "targets": targets}

    @app.get("/cleanup/{id}", operation_id="getCleanup")
    def get_cleanup(id: str) -> dict[str, object]:
        return _get_job(jobs, id, "cleanup").snapshot()

    @app.post("/restore", operation_id="restoreQuarantine")
    def restore_quarantine(payload: dict[str, object]) -> dict[str, object]:
        ids = payload.get("quarantine_ids")
        restore_all = bool(payload.get("restore_all", False))
        restored = 0
        failed = 0
        errors: list[str] = []
        try:
            if restore_all:
                result = restore_quarantine_files(db_path, restore_all=True)
                restored += result.get("restored", 0)
                failed += result.get("failed", 0)
            elif isinstance(ids, list):
                for quarantine_id in ids:
                    result = restore_quarantine_files(db_path, quarantine_id=int(quarantine_id))
                    restored += result.get("restored", 0)
                    failed += result.get("failed", 0)
            else:
                raise _http_error(400, "bad_request", "choose quarantine_ids or restore_all")
        except ValueError as exc:
            raise _http_error(400, "bad_request", str(exc)) from exc
        except RuntimeError as exc:
            raise _http_error(422, "unsafe_path", str(exc)) from exc
        return {"restored": restored, "failed": failed, "errors": errors}

    @app.get("/thumbs/{image_id}", operation_id="getThumb")
    def get_thumb(image_id: int, x_api_token: str | None = Header(default=None)) -> Response:
        manifest = open_manifest()
        try:
            row = manifest.conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
            if row is None:
                raise _http_error(404, "not_found", "image not found")
            cache = "hit"
            thumb_path = Path(row["thumb_path"]) if row["thumb_path"] else thumbs_dir / f"{image_id}.jpg"
            if not thumb_path.exists():
                cache = "miss"
                thumb_path = make_thumbnail(Path(row["path"]), thumbs_dir, image_id)
                manifest.set_thumb(image_id, thumb_path)
            return FileResponse(thumb_path, media_type="image/jpeg", headers={"X-PD-Thumb-Cache": cache})
        finally:
            manifest.close()

    @app.get("/images/{image_id}/full", operation_id="getFullImage")
    def get_full_image(image_id: int, x_api_token: str | None = Header(default=None)) -> Response:
        manifest = open_manifest()
        try:
            row = manifest.conn.execute("SELECT path FROM images WHERE id = ?", (image_id,)).fetchone()
            if row is None:
                raise _http_error(404, "not_found", "image not found")
            image_path = Path(row["path"])
            if not image_path.exists() or not image_path.is_file():
                raise _http_error(404, "not_found", "image file not found")
            media_type = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
            return FileResponse(image_path, media_type=media_type)
        finally:
            manifest.close()

    @app.get("/settings", operation_id="getSettings")
    def get_settings() -> dict[str, object]:
        return _load_settings(settings_path)

    @app.put("/settings", operation_id="putSettings")
    def put_settings(payload: dict[str, object]) -> dict[str, object]:
        settings = _normalize_settings(payload)
        _save_settings(settings_path, settings)
        return settings

    return app


def _run_scan_job(
    job: Job,
    db_path: Path,
    thumbs_dir: Path,
    cache_dir: Path,
    roots: list[Path],
    threshold: int,
    include_online_only: bool = False,
) -> None:
    manifest = Manifest(db_path, run_migrations=False)
    try:
        _raise_if_cancelled(job)
        job.set_progress(0, 0, "collecting")
        _raise_if_cancelled(job)
        scan_log = "previous results preserved until scan completion"
        files: list[ImageFile] = []
        discovered = 0
        cloud_placeholder_skipped = 0
        reparse_dir_skipped = 0
        unreadable_skipped = 0
        for root in roots:
            _raise_if_cancelled(job)
            if not root.exists():
                raise ValueError(f"root does not exist: {root}")
            def report_collection(root_discovered: int, current_path: str | None = None, cloud_placeholders: int = 0, reparse_dirs: int = 0) -> None:
                _raise_if_cancelled(job)
                job.set_progress(
                    discovered + root_discovered,
                    0,
                    "collecting",
                    current_path=current_path,
                    skipped={
                        "cloud_placeholders": cloud_placeholder_skipped + int(cloud_placeholders),
                        "reparse_dirs": reparse_dir_skipped + int(reparse_dirs),
                        "unreadable": unreadable_skipped,
                    },
                )

            if scan_folder is _scan_folder:
                root_result = scan_folder_with_stats(
                    root,
                    progress_cb=report_collection,
                    cancel_cb=lambda: _raise_if_cancelled(job),
                    include_online_only=include_online_only,
                )
            else:
                root_files = scan_folder(root, progress_cb=report_collection)
                root_result = ScanFolderResult(files=root_files, stats=ScanStats(images=len(root_files)))
            _raise_if_cancelled(job)
            files.extend(root_result.files)
            discovered += len(root_result.files)
            cloud_placeholder_skipped += root_result.stats.cloud_placeholders
            reparse_dir_skipped += root_result.stats.reparse_dirs
            unreadable_skipped += root_result.stats.unreadable
            job.set_progress(
                discovered,
                0,
                "collecting",
                current_path=str(root),
                skipped={
                    "cloud_placeholders": cloud_placeholder_skipped,
                    "reparse_dirs": reparse_dir_skipped,
                    "unreadable": unreadable_skipped,
                },
            )
        deduped_files: dict[Path, ImageFile] = {}
        for image in files:
            deduped_files.setdefault(image.path.resolve(), image)
        dedup_skipped = len(files) - len(deduped_files)
        if dedup_skipped > 0:
            scan_log = f"{scan_log}; dedup skipped: {dedup_skipped}"
        if cloud_placeholder_skipped or reparse_dir_skipped or unreadable_skipped:
            scan_log = (
                f"{scan_log}; skipped cloud_placeholders={cloud_placeholder_skipped}, "
                f"reparse_dirs={reparse_dir_skipped}, unreadable={unreadable_skipped}"
            )
        files = list(deduped_files.values())
        rows = []
        cache_hits = 0
        errors = 0
        total = len(files)
        job.set_progress(0, total, "scanning")
        for index, image in enumerate(files, start=1):
            _raise_if_cancelled(job)
            cached = manifest.cache_lookup(image)
            if cached and cached.phash and cached.dhash and cached.histogram is not None and cached.quality_score is not None:
                cache_hits += 1
                row = cached
            else:
                try:
                    _raise_if_cancelled(job)
                    fp = fingerprint(image.path)
                    _raise_if_cancelled(job)
                    q_score, sharp = quality_score(path=image.path, width=image.width, height=image.height, size_bytes=image.size_bytes, fmt=image.format)
                    _raise_if_cancelled(job)
                    row = manifest.upsert_image(image, sharpness=sharp, phash=fp.phash, dhash=fp.dhash, quality_score=q_score, histogram=fp.histogram)
                except (OSError, SyntaxError, UnidentifiedImageError) as exc:
                    errors += 1
                    job.set_progress(index, total, "scanning")
                    continue
            rows.append(row)
            job.set_progress(index, total, "scanning")
        for index, row in enumerate(rows, start=1):
            _raise_if_cancelled(job)
            if not row.thumb_path or not Path(row.thumb_path).exists():
                try:
                    _raise_if_cancelled(job)
                    manifest.set_thumb(row.id, make_thumbnail(row.path, thumbs_dir, row.id))
                except Exception:
                    pass
            job.set_progress(index, len(rows), "thumbnails")
        _raise_if_cancelled(job)
        scanned_image_ids = [row.id for row in rows]
        resolved_image_ids = _resolved_image_ids(manifest, scanned_image_ids)
        groupables = [
            GroupableImage(id=row.id, phash=row.phash or "", dhash=row.dhash or "", histogram=row.histogram or [], quality_score=float(row.quality_score or 0.0))
            for row in rows
            if row.id not in resolved_image_ids and row.phash and row.dhash and row.histogram is not None
        ]
        def report_grouping(done: int, total: int, phase: str) -> None:
            _raise_if_cancelled(job)
            job.set_progress(done, total, phase)

        groups = group_images(groupables, threshold=threshold, progress_cb=report_grouping)
        groups = manifest.filter_unevaluated_groups(groups)
        _raise_if_cancelled(job)
        quality_scores = {row.id: float(row.quality_score or 0.0) for row in rows}
        keep_by_group = {group_id: choose_keep(members, quality_scores) for group_id, members in enumerate(groups, start=1)}
        _raise_if_cancelled(job)
        replaced_groups = _replace_groups_for_scanned_images(
            manifest,
            groups,
            keep_by_group,
            threshold,
            scanned_image_ids=[image.id for image in groupables],
        )
        _raise_if_cancelled(job)
        manifest.set_meta("threshold", str(threshold))
        manifest.set_meta("last_scan_at", utc_now())
        _write_group_snapshot(cache_dir, manifest, [str(root) for root in roots])
        groups_total, duplicate_groups, reclaimable = manifest.summary()
        with job.lock:
            job.status = "done"
            job.phase = "done"
            job.done = job.total
            job.summary = {
                "images": len(rows),
                "groups": groups_total,
                "duplicate_groups": duplicate_groups,
                "reclaimable_bytes": reclaimable,
                "cache_hits": cache_hits,
                "errors": errors,
                "log": f"{scan_log}; scoped groups replaced={replaced_groups}",
            }
    except _ScanCancelled:
        _cancel(job)
    except Exception as exc:
        with job.lock:
            job.status = "error"
            job.phase = "error"
            job.error = str(exc)
            job.summary = {"error": str(exc)}
    finally:
        manifest.close()


def _resolved_image_ids(manifest: Manifest, image_ids: list[int]) -> set[int]:
    if not image_ids:
        return set()
    placeholders = ",".join("?" for _ in image_ids)
    rows = manifest.conn.execute(
        f"SELECT id FROM images WHERE id IN ({placeholders}) AND resolved_at IS NOT NULL",
        tuple(image_ids),
    ).fetchall()
    return {int(row["id"]) for row in rows}


def _replace_groups_for_scanned_images(
    manifest: Manifest,
    groups: list[list[int]],
    keep_by_group: dict[int, int],
    threshold: int,
    *,
    scanned_image_ids: list[int],
) -> int:
    if not scanned_image_ids:
        return 0

    image_placeholders = ",".join("?" for _ in scanned_image_ids)
    old_group_rows = manifest.conn.execute(
        f"""
        SELECT DISTINCT group_id
        FROM images
        WHERE id IN ({image_placeholders})
          AND group_id IS NOT NULL
        """,
        tuple(scanned_image_ids),
    ).fetchall()
    old_group_ids = [int(row["group_id"]) for row in old_group_rows]

    if old_group_ids:
        group_placeholders = ",".join("?" for _ in old_group_ids)
        manifest.conn.execute(
            f"""
            UPDATE images
            SET group_id = NULL, is_keep = 0, mark = NULL
            WHERE group_id IN ({group_placeholders})
              AND resolved_at IS NULL
              AND group_id NOT IN (
                SELECT DISTINCT group_id
                FROM images
                WHERE resolved_at IS NOT NULL
                  AND group_id IS NOT NULL
              )
            """,
            tuple(old_group_ids),
        )
        manifest.conn.execute(
            f"""
            DELETE FROM groups
            WHERE group_id IN ({group_placeholders})
              AND NOT EXISTS (
                SELECT 1
                FROM images i
                WHERE i.group_id = groups.group_id
                  AND i.resolved_at IS NOT NULL
              )
            """,
            tuple(old_group_ids),
        )

    now = utc_now()
    start_group_id = int(manifest.conn.execute("SELECT COALESCE(MAX(group_id), 0) + 1 FROM groups").fetchone()[0])
    for offset, members in enumerate(groups):
        group_id = start_group_id + offset
        keep_id = keep_by_group[offset + 1]
        member_placeholders = ",".join("?" for _ in members)
        sizes = {
            int(row["id"]): int(row["size_bytes"])
            for row in manifest.conn.execute(
                f"SELECT id, size_bytes FROM images WHERE id IN ({member_placeholders})",
                tuple(members),
            )
        }
        reclaimable = sum(size for image_id, size in sizes.items() if image_id != keep_id)
        resolved_at = manifest.evaluated_at_for_group_members(members)
        manifest.conn.execute(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at, resolved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (group_id, len(members), keep_id, reclaimable, threshold, now, resolved_at),
        )
        for image_id in members:
            manifest.conn.execute(
                "UPDATE images SET group_id = ?, is_keep = ?, mark = ? WHERE id = ?",
                (group_id, 1 if image_id == keep_id else 0, "none", image_id),
            )

    manifest.conn.execute(
        "INSERT INTO scan_meta(key, value) VALUES ('last_regroup_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (now,),
    )
    manifest.conn.commit()
    return len(old_group_ids)


def _run_cleanup_job(job: Job, db_path: Path, mode: str, group_ids: list[int] | None = None) -> None:
    manifest = Manifest(db_path, run_migrations=False)
    try:
        group_filter, params = _group_id_filter("AND", group_ids)
        rows = manifest.conn.execute(
            f"""
            SELECT id, path, group_id
            FROM images
            WHERE mark = 'delete'
              AND COALESCE(is_quarantined, 0) = 0
              {group_filter}
            ORDER BY id
            """,
            params,
        ).fetchall()
        total = len(rows)
        job.set_progress(0, total, "quarantine" if mode == "trash" else "db_update")
        quarantine_dir = dated_quarantine_dir(db_path.parent / "quarantine")
        deleted = 0
        failed = 0
        changed_group_ids: set[int] = set()
        for index, row in enumerate(rows, start=1):
            source = Path(row["path"])
            try:
                if mode == "trash":
                    quarantine_dir.mkdir(parents=True, exist_ok=True)
                    target = quarantine_dir / source.name
                    suffix = 1
                    while target.exists():
                        target = quarantine_dir / f"{source.stem}_{suffix}{source.suffix}"
                        suffix += 1
                    shutil.move(str(source), str(target))
                    manifest.conn.execute(
                        "UPDATE images SET is_quarantined = 1, resolved_at = ? WHERE id = ?",
                        (utc_now(), int(row["id"])),
                    )
                else:
                    source.unlink()
                    manifest.conn.execute(
                        "UPDATE images SET is_quarantined = 1, resolved_at = ? WHERE id = ?",
                        (utc_now(), int(row["id"])),
                    )
                manifest.conn.commit()
                deleted += 1
                group_id = row["group_id"] if "group_id" in row.keys() else None
                if group_id is not None:
                    changed_group_ids.add(int(group_id))
            except Exception:
                failed += 1
            job.set_progress(index, total, "db_update")
        _record_terminal_evaluated_groups(manifest, changed_group_ids)
        with job.lock:
            job.status = "done"
            job.phase = "done"
            job.done = total
            job.total = total
            job.summary = {"deleted": deleted, "failed": failed}
    except Exception as exc:
        with job.lock:
            job.status = "error"
            job.phase = "error"
            job.summary = {"error": str(exc)}
    finally:
        manifest.close()


def _record_terminal_evaluated_groups(manifest: Manifest, group_ids: set[int]) -> int:
    recorded = 0
    for group_id in sorted(group_ids):
        row = manifest.conn.execute(
            """
            SELECT COUNT(*) AS active_count,
                   SUM(CASE WHEN mark IN ('keep', 'delete') THEN 1 ELSE 0 END) AS terminal_marks
            FROM images
            WHERE group_id = ?
              AND resolved_at IS NULL
              AND COALESCE(is_quarantined, 0) = 0
            """,
            (group_id,),
        ).fetchone()
        active_count = int(row["active_count"] or 0)
        terminal_marks = int(row["terminal_marks"] or 0)
        if active_count > 0 and active_count != terminal_marks:
            continue
        resolved_at = utc_now()
        if manifest.record_evaluated_group(group_id, evaluated_at=resolved_at) is None:
            continue
        manifest.mark_group_resolved(group_id, resolved_at=resolved_at)
        recorded += 1
    if recorded:
        manifest.conn.commit()
    return recorded


def _list_groups(manifest: Manifest, limit: int, offset: int, sort: str, status: str, min_size: int | None, max_size: int | None, min_similarity: float | None) -> list[dict[str, object]]:
    order = {
        "created_at": "g.created_at DESC",
        "group_size": "g.member_count DESC",
        "reclaimable_bytes": "g.reclaimable_bytes DESC",
        "similarity": "g.threshold DESC",
        "quality": "MAX(COALESCE(i.quality_score, 0)) DESC",
    }.get(sort, "g.reclaimable_bytes DESC")
    where, params = _group_list_filters(status, min_size, max_size, min_similarity)
    params.extend([limit, offset])
    rows = manifest.conn.execute(
        f"""
        SELECT g.*, MIN(i.id) AS thumbnail_image_id, MAX(COALESCE(i.quality_score, 0)) AS max_quality
        FROM groups g
        LEFT JOIN images i ON i.group_id = g.group_id
        WHERE {' AND '.join(where)}
        GROUP BY g.group_id
        ORDER BY {order}
        LIMIT ? OFFSET ?
        """,
        tuple(params),
    ).fetchall()
    return _group_payloads(manifest, rows)


def _count_list_groups(manifest: Manifest, status: str, min_size: int | None, max_size: int | None, min_similarity: float | None) -> int:
    where, params = _group_list_filters(status, min_size, max_size, min_similarity)
    row = manifest.conn.execute(
        f"SELECT COUNT(*) FROM groups g WHERE {' AND '.join(where)}",
        tuple(params),
    ).fetchone()
    return int(row[0])


def _group_list_filters(status: str, min_size: int | None, max_size: int | None, min_similarity: float | None) -> tuple[list[str], list[object]]:
    where = ["g.member_count >= ?"]
    params: list[object] = [max(2, min_size or 2)]
    if status == "unresolved":
        where.append("g.resolved_at IS NULL")
        where.append("NOT EXISTS (SELECT 1 FROM images x WHERE x.group_id = g.group_id AND x.resolved_at IS NOT NULL)")
        where.append(
            """
            (
              SELECT COUNT(*)
              FROM images live
              WHERE live.group_id = g.group_id
                AND live.resolved_at IS NULL
                AND COALESCE(live.is_quarantined, 0) = 0
            ) >= 2
            """
        )
        where.append(
            """
            NOT (
              COALESCE(g.reclaimable_bytes, 0) = 0
              AND NOT EXISTS (
                SELECT 1
                FROM images target
                WHERE target.group_id = g.group_id
                  AND target.resolved_at IS NULL
                  AND COALESCE(target.is_quarantined, 0) = 0
                  AND target.mark = 'delete'
              )
            )
            """
        )
    elif status == "processed":
        where.append("(g.resolved_at IS NOT NULL OR EXISTS (SELECT 1 FROM images x WHERE x.group_id = g.group_id AND x.resolved_at IS NOT NULL))")
    if max_size is not None:
        where.append("g.member_count <= ?")
        params.append(max_size)
    if min_similarity is not None:
        where.append("g.threshold >= ?")
        params.append(min_similarity)
    return where, params


def _count_in_scope(manifest: Manifest, group_id: int, roots: list[str]) -> int:
    rows = manifest.conn.execute("SELECT path FROM images WHERE group_id = ?", (group_id,)).fetchall()
    return sum(1 for row in rows if any(_path_under(str(row["path"]), root) for root in roots))


def _in_scope_counts(manifest: Manifest, group_ids: list[int], roots: list[str]) -> dict[int, int]:
    counts = {group_id: 0 for group_id in group_ids}
    for chunk in _chunks(group_ids, 900):
        placeholders = ",".join("?" for _ in chunk)
        rows = manifest.conn.execute(
            f"SELECT group_id, path FROM images WHERE group_id IN ({placeholders})",
            tuple(chunk),
        ).fetchall()
        for row in rows:
            group_id = int(row["group_id"])
            if any(_path_under(str(row["path"]), root) for root in roots):
                counts[group_id] = counts.get(group_id, 0) + 1
    return counts


def _path_under(child: str, root: str) -> bool:
    child_path = _normalize_scope_path(child)
    root_path = _normalize_scope_path(root)
    return child_path == root_path or child_path.startswith(f"{root_path}/")


def _normalize_scope_path(path: str) -> str:
    normalized = posixpath.normpath(path.replace("\\", "/"))
    return normalized.rstrip("/").lower()


def _snapshot_path(cache_dir: Path, roots: list[str]) -> Path:
    digest = hashlib.sha256(json.dumps(_normalized_root_set(roots), ensure_ascii=False).encode("utf-8")).hexdigest()[:16]
    return cache_dir / f"groups-{digest}.json"


def _normalized_root_set(roots: list[str]) -> list[str]:
    return sorted(dict.fromkeys(_normalize_scope_path(root) for root in roots if root.strip()))


def _snapshot_roots_match(payload: object, requested_roots: list[str]) -> bool:
    if not isinstance(payload, dict):
        return False
    snapshot_roots = payload.get("roots")
    if not isinstance(snapshot_roots, list) or not all(isinstance(root, str) for root in snapshot_roots):
        return False
    return _normalized_root_set(snapshot_roots) == _normalized_root_set(requested_roots)


def _discard_snapshot(snapshot_path: Path) -> None:
    try:
        snapshot_path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        print(f"group snapshot discard failed path={snapshot_path} error={exc}", file=sys.stderr, flush=True)


def _snapshot_payload(manifest: Manifest, roots: list[str]) -> dict[str, object]:
    items = _list_groups(manifest, -1 if roots else 200, 0, "reclaimable_bytes", "unresolved", None, None, None)
    if roots:
        filtered = []
        for group in items:
            in_scope_count = _count_in_scope(manifest, int(group["id"]), roots)
            if in_scope_count >= 2:
                filtered.append({**group, "member_count": in_scope_count})
        items = filtered[:200]
    details = [_group_detail(manifest, int(group["id"]), roots or None) for group in items]
    _prune_group_completions(manifest.db_path.parent / "cache", _active_group_ids(manifest))
    return {
        "version": 1,
        "generated_at": utc_now(),
        "roots": roots,
        "items": details,
    }


def _write_group_snapshot(cache_dir: Path, manifest: Manifest, roots: list[str]) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path = _snapshot_path(cache_dir, roots)
    tmp_path = snapshot_path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(_snapshot_payload(manifest, roots), ensure_ascii=False), encoding="utf-8")
    tmp_path.replace(snapshot_path)
    print(f"group snapshot saved path={snapshot_path}", file=sys.stderr, flush=True)
    return snapshot_path


def _group_detail(manifest: Manifest, group_id: int, roots: list[str] | None = None) -> dict[str, object]:
    group = manifest.conn.execute("SELECT g.*, MIN(i.id) AS thumbnail_image_id FROM groups g LEFT JOIN images i ON i.group_id = g.group_id WHERE g.group_id = ? GROUP BY g.group_id", (group_id,)).fetchone()
    if group is None:
        raise _http_error(404, "not_found", "group not found")
    images = manifest.conn.execute(
        """
        SELECT i.*, g.keep_image_id, h.histogram
        FROM images i
        JOIN groups g ON g.group_id = i.group_id
        LEFT JOIN image_histograms h ON h.image_id = i.id
        WHERE i.group_id = ?
        ORDER BY i.id
        """,
        (group_id,),
    ).fetchall()
    if roots:
        images = [row for row in images if any(_path_under(str(row["path"]), root) for root in roots)]
    images = _sort_group_images(images)
    group_payload = _group_payload(manifest, group)
    if roots:
        marks = [row["mark"] or "none" for row in images]
        group_payload["member_count"] = len(images)
        group_payload["total_count"] = len(images)
        group_payload["marked_count"] = sum(1 for mark in marks if mark in {"keep", "delete"})
        group_payload["thumbnail_image_id"] = int(images[0]["id"]) if images else None
        group_payload["cover_image_id"] = int(images[0]["id"]) if images else None
    recommended = next((row for row in images if int(row["id"]) == int(row["keep_image_id"] or -1)), None)
    similarities = {
        int(row["id"]): 100.0 if recommended is not None and int(row["id"]) == int(recommended["id"]) else (
            _similarity_to_recommended(recommended, row) if recommended is not None else None
        )
        for row in images
    }
    return {"group": group_payload, "images": [_image_payload(row, similarities.get(int(row["id"]))) for row in images]}


def _details_for_group_items(manifest: Manifest, items: list[dict[str, object]], roots: list[str] | None) -> list[dict[str, object]]:
    if not items:
        return []
    group_ids = [int(group["id"]) for group in items]
    images_by_group = _images_by_group(manifest, group_ids)
    details = []
    for group in items:
        group_id = int(group["id"])
        images = images_by_group.get(group_id, [])
        if roots:
            images = [row for row in images if any(_path_under(str(row["path"]), root) for root in roots)]
        images = _sort_group_images(images)
        payload = dict(group)
        if roots:
            marks = [row["mark"] or "none" for row in images]
            payload["member_count"] = len(images)
            payload["total_count"] = len(images)
            payload["marked_count"] = sum(1 for mark in marks if mark in {"keep", "delete"})
            payload["thumbnail_image_id"] = int(images[0]["id"]) if images else None
            payload["cover_image_id"] = int(images[0]["id"]) if images else None
        recommended = next((row for row in images if int(row["id"]) == int(row["keep_image_id"] or -1)), None)
        similarities = {
            int(row["id"]): 100.0 if recommended is not None and int(row["id"]) == int(recommended["id"]) else (
                _similarity_to_recommended(recommended, row) if recommended is not None else None
            )
            for row in images
        }
        details.append({"group": payload, "images": [_image_payload(row, similarities.get(int(row["id"]))) for row in images]})
    return details


def _images_by_group(manifest: Manifest, group_ids: list[int]) -> dict[int, list]:
    images_by_group: dict[int, list] = {group_id: [] for group_id in group_ids}
    for chunk in _chunks(group_ids, 900):
        placeholders = ",".join("?" for _ in chunk)
        rows = manifest.conn.execute(
            f"""
            SELECT i.*, g.keep_image_id, h.histogram
            FROM images i
            JOIN groups g ON g.group_id = i.group_id
            LEFT JOIN image_histograms h ON h.image_id = i.id
            WHERE i.group_id IN ({placeholders})
            ORDER BY i.group_id, i.id
            """,
            tuple(chunk),
        ).fetchall()
        for row in rows:
            images_by_group.setdefault(int(row["group_id"]), []).append(row)
    return images_by_group


def _group_payloads(manifest: Manifest, rows: list) -> list[dict[str, object]]:
    if not rows:
        return []
    group_ids = [int(row["group_id"]) for row in rows]
    marks_by_group: dict[int, list[tuple[int, str]]] = {group_id: [] for group_id in group_ids}
    for chunk in _chunks(group_ids, 900):
        placeholders = ",".join("?" for _ in chunk)
        image_rows = manifest.conn.execute(
            f"SELECT group_id, id, mark FROM images WHERE group_id IN ({placeholders}) ORDER BY group_id, id",
            tuple(chunk),
        ).fetchall()
        for image in image_rows:
            marks_by_group.setdefault(int(image["group_id"]), []).append((int(image["id"]), image["mark"] or "none"))
    completed = _load_group_completions(manifest.db_path.parent / "cache")
    return [_group_payload_from_marks(row, marks_by_group.get(int(row["group_id"]), []), completed) for row in rows]


def _group_payload(manifest: Manifest, row) -> dict[str, object]:
    return _group_payloads(manifest, [row])[0]


def _group_payload_from_marks(row, image_marks: list[tuple[int, str]], completed_group_ids: set[int]) -> dict[str, object]:
    group_id = int(row["group_id"])
    marks = [mark for _, mark in image_marks]
    marked_count = sum(1 for mark in marks if mark in {"keep", "delete"})
    recommended = []
    for image_id, mark in image_marks:
        expected = "keep" if image_id == int(row["keep_image_id"] or -1) else "delete"
        recommended.append(mark == expected)
    if marks and all(mark == "keep" for mark in marks):
        state = "keep_all"
    elif marks and all(mark == "delete" for mark in marks):
        state = "delete_all"
    elif recommended and all(recommended):
        state = "recommended_applied"
    else:
        state = "mixed"
    return {
        "id": group_id,
        "member_count": int(row["member_count"] or 0),
        "recommended_keep_image_id": int(row["keep_image_id"]) if row["keep_image_id"] is not None else None,
        "selection_state": state,
        "max_similarity": float(row["threshold"]) if row["threshold"] is not None else None,
        "reclaimable_bytes": int(row["reclaimable_bytes"] or 0),
        "thumbnail_image_id": int(row["thumbnail_image_id"]) if row["thumbnail_image_id"] is not None else None,
        "cover_image_id": int(row["thumbnail_image_id"]) if row["thumbnail_image_id"] is not None else None,
        "marked_count": marked_count,
        "total_count": len(marks),
        "completed": group_id in completed_group_ids,
    }


def _chunks(values: list[int], size: int) -> list[list[int]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


def _image_payload(row, similarity_to_recommended: float | None = None) -> dict[str, object]:
    return {
        "id": int(row["id"]),
        "path": row["path"],
        "size_bytes": int(row["size_bytes"] or 0),
        "width": int(row["width"]) if row["width"] is not None else None,
        "height": int(row["height"]) if row["height"] is not None else None,
        "format": row["format"],
        "quality_score": float(row["quality_score"]) if row["quality_score"] is not None else None,
        "sharpness": float(row["sharpness"]) if row["sharpness"] is not None else None,
        "taken_at": row["taken_at"],
        "mark": row["mark"] or "none",
        "recommended_keep": int(row["id"]) == int(row["keep_image_id"] or -1),
        "is_quarantined": bool(row["is_quarantined"] or 0),
        "similarity_to_recommended": similarity_to_recommended,
    }


def _sort_group_images(rows: list) -> list:
    if len(rows) < 2:
        return list(rows)
    recommended = next((row for row in rows if int(row["id"]) == int(row["keep_image_id"] or -1)), None)
    if recommended is None:
        return list(rows)
    similarities: dict[int, float] = {}
    for row in rows:
        if int(row["id"]) == int(recommended["id"]):
            continue
        similarities[int(row["id"])] = _similarity_to_recommended(recommended, row)
    if not similarities:
        return list(rows)
    farthest_id = min(similarities, key=lambda image_id: (similarities[image_id], image_id))
    remaining = sorted(
        (row for row in rows if int(row["id"]) not in {int(recommended["id"]), farthest_id}),
        key=lambda row: (-similarities.get(int(row["id"]), -1.0), int(row["id"])),
    )
    farthest = next(row for row in rows if int(row["id"]) == farthest_id)
    return [recommended, farthest, *remaining]


def _similarity_to_recommended(recommended, row) -> float:
    try:
        left_histogram = json.loads(recommended["histogram"]) if recommended["histogram"] else []
        right_histogram = json.loads(row["histogram"]) if row["histogram"] else []
        if recommended["phash"] and recommended["dhash"] and row["phash"] and row["dhash"] and left_histogram and right_histogram:
            return similarity_percent(
                recommended["phash"],
                recommended["dhash"],
                left_histogram,
                row["phash"],
                row["dhash"],
                right_histogram,
            )
    except (TypeError, ValueError):
        pass
    return -1.0


def _completion_path(cache_dir: Path) -> Path:
    return cache_dir / "group-completions.json"


def _load_group_completions(cache_dir: Path) -> set[int]:
    path = _completion_path(cache_dir)
    if not path.exists():
        return set()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    values = payload.get("completed_group_ids") if isinstance(payload, dict) else None
    if not isinstance(values, list):
        return set()
    return {int(value) for value in values if isinstance(value, int)}


def _save_group_completions(cache_dir: Path, group_ids: set[int]) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = _completion_path(cache_dir)
    tmp_path = path.with_suffix(".tmp")
    payload = {
        "version": 1,
        "updated_at": utc_now(),
        "completed_group_ids": sorted(group_ids),
    }
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def _mark_group_completed(cache_dir: Path, group_id: int) -> None:
    completed = _load_group_completions(cache_dir)
    completed.add(group_id)
    _save_group_completions(cache_dir, completed)


def _is_group_completed(cache_dir: Path, group_id: int) -> bool:
    return group_id in _load_group_completions(cache_dir)


def _prune_group_completions(cache_dir: Path, active_group_ids: list[int]) -> None:
    completed = _load_group_completions(cache_dir)
    active = set(active_group_ids)
    stale_removed = completed.intersection(active)
    if stale_removed != completed:
        _save_group_completions(cache_dir, stale_removed)


def _active_group_ids(manifest: Manifest) -> list[int]:
    rows = manifest.conn.execute("SELECT group_id FROM groups").fetchall()
    return [int(row["group_id"]) for row in rows]


def _load_settings(settings_path: Path) -> dict[str, object]:
    if settings_path.exists():
        return _normalize_settings(json.loads(settings_path.read_text(encoding="utf-8")))
    return dict(DEFAULT_SETTINGS)


def _save_settings(settings_path: Path, settings: dict[str, object]) -> None:
    settings_path.write_text(json.dumps(_normalize_settings(settings), ensure_ascii=False, indent=2), encoding="utf-8")


def _normalize_settings(payload: dict[str, object]) -> dict[str, object]:
    settings = dict(DEFAULT_SETTINGS)
    settings.update(payload)
    if not isinstance(settings["threshold"], int) or not 0 <= settings["threshold"] <= 100:
        raise _http_error(400, "bad_request", "threshold must be between 0 and 100")
    if settings["cleanup_mode"] not in {"trash", "permanent"}:
        raise _http_error(400, "bad_request", "cleanup_mode must be trash or permanent")
    scan_folders = settings.get("scan_folders", [])
    if not isinstance(scan_folders, list) or not all(isinstance(root, str) for root in scan_folders):
        raise _http_error(400, "bad_request", "scan_folders must be a string array")
    settings["scan_folders"] = list(dict.fromkeys(root.strip() for root in scan_folders if root.strip()))
    updated_at = settings.get("scan_folders_updated_at")
    if updated_at is not None and not isinstance(updated_at, str):
        raise _http_error(400, "bad_request", "scan_folders_updated_at must be a string or null")
    if not isinstance(settings.get("include_online_only"), bool):
        raise _http_error(400, "bad_request", "include_online_only must be a boolean")
    return settings


def _get_job(jobs: dict[str, Job], job_id: str, kind: str) -> Job:
    job = jobs.get(job_id)
    if job is None or job.kind != kind:
        raise _http_error(404, "not_found", "job not found")
    return job


def _count_delete_marks(db_path: Path, group_ids: list[int] | None = None) -> int:
    manifest = Manifest(db_path, run_migrations=False)
    try:
        group_filter, params = _group_id_filter("AND", group_ids)
        return int(manifest.conn.execute(f"SELECT COUNT(*) FROM images WHERE mark = 'delete' {group_filter}", params).fetchone()[0])
    finally:
        manifest.close()


def _parse_group_ids(value: object) -> list[int] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(item, int) for item in value):
        raise _http_error(400, "bad_request", "group_ids must be an integer array")
    return list(dict.fromkeys(int(item) for item in value))


def _group_id_filter(prefix: str, group_ids: list[int] | None) -> tuple[str, tuple[object, ...]]:
    if group_ids is None:
        return "", ()
    if not group_ids:
        return f"{prefix} 1 = 0", ()
    placeholders = ",".join("?" for _ in group_ids)
    return f"{prefix} group_id IN ({placeholders})", tuple(group_ids)


def _cancel(job: Job) -> None:
    with job.lock:
        job.status = "cancelled"
        job.phase = "done"


class _ScanCancelled(Exception):
    pass


def _raise_if_cancelled(job: Job) -> None:
    with job.lock:
        cancelled = job.cancel_requested or job.status == "cancelled"
    if cancelled:
        raise _ScanCancelled()


def _http_error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"code": code, "message": message, "request_id": uuid.uuid4().hex}})


def _error_response(status: int, code: str, message: str) -> Response:
    return Response(
        json.dumps({"error": {"code": code, "message": message, "request_id": uuid.uuid4().hex}}),
        status_code=status,
        media_type="application/json",
    )
