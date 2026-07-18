from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import logging
from pathlib import Path
import shutil
import sqlite3

from send2trash import send2trash

from .manifest import Manifest, utc_now

LOGGER = logging.getLogger(__name__)

DEFAULT_QUARANTINE_ROOT = Path(r"C:\photo-dedup-trash")


@dataclass(frozen=True)
class CleanupPlanItem:
    image_id: int
    original_path: Path
    quarantine_path: Path
    size: int
    phash: str | None
    group_id: int | None


@dataclass(frozen=True)
class CleanupSummary:
    count: int
    bytes: int


def _norm(value: Path | str) -> str:
    return str(value).replace("/", "\\").casefold().rstrip("\\")


def _is_under(path: Path | str, root: Path | str) -> bool:
    path_norm = _norm(path)
    root_norm = _norm(root)
    return path_norm == root_norm or path_norm.startswith(root_norm + "\\")


def ensure_quarantine_destination_safe(path: Path, protected_root: Path | None = None) -> None:
    if protected_root is not None and _is_under(path, protected_root):
        raise RuntimeError(f"Quarantine destination is inside protected root: {path}")


def dated_quarantine_dir(root: Path = DEFAULT_QUARANTINE_ROOT, today: datetime | None = None) -> Path:
    stamp = (today or datetime.now()).strftime("%Y%m%d")
    return root / stamp


def _unique_destination(dest_dir: Path, source: Path, reserved: set[str]) -> Path:
    candidate = dest_dir / source.name
    stem = source.stem
    suffix = source.suffix
    index = 1
    while _norm(candidate) in reserved or candidate.exists():
        candidate = dest_dir / f"{stem}_{index}{suffix}"
        index += 1
    reserved.add(_norm(candidate))
    return candidate


def build_dryrun_plan(
    db_path: Path,
    quarantine_dir: Path | None = None,
    *,
    protected_root: Path | None = None,
    group_id: int | None = None,
) -> list[CleanupPlanItem]:
    destination = quarantine_dir or dated_quarantine_dir()
    ensure_quarantine_destination_safe(destination, protected_root)
    manifest = Manifest(db_path)
    try:
        group_filter = "AND i.group_id = ?" if group_id is not None else ""
        params: tuple[object, ...] = (group_id,) if group_id is not None else ()
        rows = manifest.conn.execute(
            f"""
            SELECT i.id, i.path, i.size_bytes, i.phash, i.group_id
            FROM images i
            JOIN groups g ON g.group_id = i.group_id
            WHERE i.is_keep = 0
              AND COALESCE(i.is_quarantined, 0) = 0
              AND i.resolved_at IS NULL
              AND g.member_count > 1
              AND COALESCE(g.keep_all, 0) = 0
              {group_filter}
            ORDER BY i.group_id ASC, i.id ASC
            """,
            params,
        ).fetchall()
    finally:
        manifest.close()

    return _plan_from_rows(rows, destination, protected_root=protected_root)


def build_keep_selection_plan(
    db_path: Path,
    group_id: int,
    keep_image_id: int,
    quarantine_dir: Path | None = None,
    *,
    protected_root: Path | None = None,
) -> list[CleanupPlanItem]:
    destination = quarantine_dir or dated_quarantine_dir()
    ensure_quarantine_destination_safe(destination, protected_root)
    manifest = Manifest(db_path)
    try:
        rows = manifest.conn.execute(
            """
            SELECT i.id, i.path, i.size_bytes, i.phash, i.group_id
            FROM images i
            JOIN groups g ON g.group_id = i.group_id
            WHERE i.group_id = ?
              AND i.id != ?
              AND COALESCE(i.is_quarantined, 0) = 0
              AND i.resolved_at IS NULL
              AND g.member_count > 1
              AND COALESCE(g.keep_all, 0) = 0
            ORDER BY i.id ASC
            """,
            (group_id, keep_image_id),
        ).fetchall()
    finally:
        manifest.close()

    return _plan_from_rows(rows, destination, protected_root=protected_root)


def build_image_quarantine_plan(
    db_path: Path,
    image_id: int,
    quarantine_dir: Path | None = None,
    *,
    protected_root: Path | None = None,
) -> list[CleanupPlanItem]:
    destination = quarantine_dir or dated_quarantine_dir()
    ensure_quarantine_destination_safe(destination, protected_root)
    manifest = Manifest(db_path)
    try:
        rows = manifest.conn.execute(
            """
            SELECT id, path, size_bytes, phash, group_id
            FROM images
            WHERE id = ?
              AND COALESCE(is_quarantined, 0) = 0
              AND resolved_at IS NULL
            """,
            (image_id,),
        ).fetchall()
    finally:
        manifest.close()

    return _plan_from_rows(rows, destination, protected_root=protected_root)


def build_images_quarantine_plan(
    db_path: Path,
    image_ids: list[int],
    quarantine_dir: Path | None = None,
    *,
    protected_root: Path | None = None,
) -> list[CleanupPlanItem]:
    unique_ids = list(dict.fromkeys(int(image_id) for image_id in image_ids))
    if not unique_ids:
        return []
    destination = quarantine_dir or dated_quarantine_dir()
    ensure_quarantine_destination_safe(destination, protected_root)
    manifest = Manifest(db_path)
    try:
        placeholders = ",".join("?" for _ in unique_ids)
        rows = manifest.conn.execute(
            f"""
            SELECT id, path, size_bytes, phash, group_id
            FROM images
            WHERE id IN ({placeholders})
              AND COALESCE(is_quarantined, 0) = 0
              AND resolved_at IS NULL
            ORDER BY id ASC
            """,
            tuple(unique_ids),
        ).fetchall()
    finally:
        manifest.close()

    return _plan_from_rows(rows, destination, protected_root=protected_root)


def _plan_from_rows(
    rows: list[sqlite3.Row],
    destination: Path,
    *,
    protected_root: Path | None = None,
) -> list[CleanupPlanItem]:
    reserved: set[str] = set()
    plan: list[CleanupPlanItem] = []
    for row in rows:
        original = Path(row["path"])
        quarantine_path = _unique_destination(destination, original, reserved)
        ensure_quarantine_destination_safe(quarantine_path, protected_root)
        plan.append(
            CleanupPlanItem(
                image_id=int(row["id"]),
                original_path=original,
                quarantine_path=quarantine_path,
                size=int(row["size_bytes"] or 0),
                phash=row["phash"],
                group_id=row["group_id"],
            )
        )
    return plan


def summarize_plan(plan: list[CleanupPlanItem]) -> CleanupSummary:
    return CleanupSummary(count=len(plan), bytes=sum(item.size for item in plan))


def plan_to_dict(plan: list[CleanupPlanItem]) -> dict[str, object]:
    summary = summarize_plan(plan)
    return {
        "summary": {"count": summary.count, "bytes": summary.bytes},
        "items": [
            {
                "image_id": item.image_id,
                "original_path": str(item.original_path),
                "quarantine_path": str(item.quarantine_path),
                "size": item.size,
                "phash": item.phash,
                "group_id": item.group_id,
            }
            for item in plan
        ],
    }


def plan_to_json(plan: list[CleanupPlanItem]) -> str:
    return json.dumps(plan_to_dict(plan), ensure_ascii=False, indent=2)


def _candidate_still_valid(conn: sqlite3.Connection, item: CleanupPlanItem, allow_keep_ids: set[int] | None = None) -> bool:
    row = conn.execute(
        "SELECT path, is_keep, resolved_at, COALESCE(is_quarantined, 0) AS is_quarantined FROM images WHERE id = ?",
        (item.image_id,),
    ).fetchone()
    if row is None or int(row["is_quarantined"] or 0) != 0:
        return False
    if row["resolved_at"] is not None:
        return False
    if int(row["is_keep"] or 0) == 0:
        return True
    return item.image_id in (allow_keep_ids or set())


def quarantine_plan(
    db_path: Path,
    plan: list[CleanupPlanItem],
    *,
    protected_root: Path | None = None,
    allow_keep_ids: set[int] | None = None,
) -> dict[str, int]:
    counts = {"quarantined": 0, "failed": 0, "skipped": 0}
    manifest = Manifest(db_path)
    try:
        for item in plan:
            ensure_quarantine_destination_safe(item.quarantine_path, protected_root)
            if not _candidate_still_valid(manifest.conn, item, allow_keep_ids):
                counts["skipped"] += 1
                continue
            if not item.original_path.exists():
                _record_quarantine(manifest.conn, item, status="failed", moved_at=utc_now())
                counts["failed"] += 1
                LOGGER.warning("Missing source, skipped: %s", item.original_path)
                continue
            actual_size = item.original_path.stat().st_size
            if actual_size != item.size:
                _record_quarantine(manifest.conn, item, status="failed", moved_at=utc_now())
                counts["failed"] += 1
                LOGGER.warning("Size changed, skipped: %s", item.original_path)
                continue
            item.quarantine_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(item.original_path), str(item.quarantine_path))
            _record_quarantine(manifest.conn, item, status="quarantined", moved_at=utc_now())
            manifest.conn.execute("UPDATE images SET is_quarantined = 1 WHERE id = ?", (item.image_id,))
            manifest.conn.commit()
            counts["quarantined"] += 1
    finally:
        manifest.close()
    return counts


def _record_quarantine(conn: sqlite3.Connection, item: CleanupPlanItem, *, status: str, moved_at: str) -> None:
    conn.execute(
        """
        INSERT INTO quarantine(image_id, original_path, quarantine_path, size, phash, group_id, moved_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            item.image_id,
            str(item.original_path),
            str(item.quarantine_path),
            item.size,
            item.phash,
            item.group_id,
            moved_at,
            status,
        ),
    )
    conn.commit()


def restore_quarantine(
    db_path: Path,
    *,
    quarantine_id: int | None = None,
    date: str | None = None,
    restore_all: bool = False,
    protected_root: Path | None = None,
) -> dict[str, int]:
    if sum(value is not None and value is not False for value in (quarantine_id, date, restore_all)) != 1:
        raise ValueError("Choose exactly one restore selector: id, date, or all")
    manifest = Manifest(db_path)
    counts = {"restored": 0, "failed": 0, "skipped": 0}
    try:
        where = ["status = 'quarantined'"]
        params: list[object] = []
        if quarantine_id is not None:
            where.append("id = ?")
            params.append(quarantine_id)
        elif date is not None:
            where.append("replace(quarantine_path, '/', '\\') LIKE ?")
            params.append(f"%\\{date}\\%")
        rows = manifest.conn.execute(
            f"SELECT * FROM quarantine WHERE {' AND '.join(where)} ORDER BY id ASC",
            tuple(params),
        ).fetchall()
        for row in rows:
            quarantine_path = Path(row["quarantine_path"])
            original_path = Path(row["original_path"])
            ensure_quarantine_destination_safe(quarantine_path, protected_root)
            if not quarantine_path.exists():
                counts["failed"] += 1
                LOGGER.warning("Missing quarantine file, skipped restore: %s", quarantine_path)
                continue
            if original_path.exists():
                counts["skipped"] += 1
                LOGGER.warning("Original path already exists, skipped restore: %s", original_path)
                continue
            original_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(quarantine_path), str(original_path))
            manifest.conn.execute(
                "UPDATE quarantine SET status = 'restored', restored_at = ? WHERE id = ?",
                (utc_now(), int(row["id"])),
            )
            manifest.conn.execute("UPDATE images SET is_quarantined = 0 WHERE id = ?", (int(row["image_id"]),))
            manifest.conn.commit()
            counts["restored"] += 1
    finally:
        manifest.close()
    return counts


def trash_path(path: Path) -> None:
    send2trash(str(path))


def list_quarantine(db_path: Path) -> list[dict[str, object]]:
    manifest = Manifest(db_path)
    try:
        rows = manifest.conn.execute(
            """
            SELECT id, image_id, original_path, quarantine_path, size, phash, group_id,
                   moved_at, restored_at, status
            FROM quarantine
            ORDER BY id DESC
            """
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        manifest.close()
