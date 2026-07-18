from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Callable

from PIL import UnidentifiedImageError

from .cleanup import (
    build_dryrun_plan,
    dated_quarantine_dir,
    list_quarantine,
    plan_to_json,
    quarantine_plan,
    restore_quarantine,
    summarize_plan,
)
from .grouping import GroupableImage, group_images
from .hashing import fingerprint
from .manifest import Manifest, utc_now
from .quality import choose_keep, quality_score
from .scanner import scan_folder
from .thumbs import make_thumbnail

LOGGER = logging.getLogger(__name__)
DEFAULT_THRESHOLD = 90
ProgressCallback = Callable[[int, int, str], None]


def human_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    amount = float(value)
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            return f"{amount:.1f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    return f"{value} B"


def _maybe_progress(
    progress_cb: ProgressCallback | None,
    processed: int,
    total: int,
    phase: str,
    *,
    force: bool = False,
) -> None:
    if progress_cb is None:
        return
    step = max(1, total // 100) if total else 1
    if force or processed == 0 or processed == total or processed % 50 == 0 or processed % step == 0:
        progress_cb(processed, total, phase)


def run_scan(
    folder: Path,
    db_path: Path,
    threshold: int,
    rescan: bool = False,
    progress_cb: ProgressCallback | None = None,
    include_keep_all: bool = False,
) -> dict[str, int]:
    if threshold < 0 or threshold > 100:
        raise ValueError("threshold must be between 0 and 100")
    manifest = Manifest(db_path)
    try:
        if include_keep_all:
            manifest.conn.execute("UPDATE images SET keep_all = 0")
            manifest.conn.execute("UPDATE groups SET keep_all = 0")
            manifest.conn.commit()
        if rescan:
            manifest.conn.execute("UPDATE images SET resolved_at = NULL")
            manifest.conn.commit()
        progress_cb and progress_cb(0, 0, "scanning")
        files = scan_folder(folder)
        total = len(files)
        _maybe_progress(progress_cb, 0, total, "scanning", force=True)
        rows = []
        cache_hits = 0
        errors = 0
        for index, image in enumerate(files, start=1):
            cached = None if rescan else manifest.cache_lookup(image)
            if (
                cached
                and cached.phash
                and cached.dhash
                and cached.histogram is not None
                and cached.quality_score is not None
                and cached.sharpness is not None
            ):
                cache_hits += 1
                row = cached
            else:
                try:
                    fp = fingerprint(image.path)
                    q_score, sharp = quality_score(
                        path=image.path,
                        width=image.width,
                        height=image.height,
                        size_bytes=image.size_bytes,
                        fmt=image.format,
                    )
                    row = manifest.upsert_image(
                        image,
                        sharpness=sharp,
                        phash=fp.phash,
                        dhash=fp.dhash,
                        quality_score=q_score,
                        histogram=fp.histogram,
                    )
                except (OSError, SyntaxError, UnidentifiedImageError) as exc:
                    LOGGER.warning("skip unreadable image: %s (%s)", image.path, exc)
                    errors += 1
                    _maybe_progress(progress_cb, index, total, "scanning")
                    continue
                except Exception as exc:
                    LOGGER.warning("skip unreadable image: %s (%s)", image.path, exc)
                    errors += 1
                    _maybe_progress(progress_cb, index, total, "scanning")
                    continue
            rows.append(row)
            _maybe_progress(progress_cb, index, total, "scanning")

        thumb_root = db_path.parent / "thumbnails"
        _maybe_progress(progress_cb, 0, len(rows), "thumbnails", force=True)
        for index, row in enumerate(rows, start=1):
            if row.thumb_path and Path(row.thumb_path).exists() and not rescan:
                _maybe_progress(progress_cb, index, len(rows), "thumbnails")
                continue
            try:
                thumb = make_thumbnail(row.path, thumb_root, row.id)
                manifest.set_thumb(row.id, thumb)
            except Exception as exc:
                LOGGER.warning("Failed to create thumbnail for %s: %s", row.path, exc)
            _maybe_progress(progress_cb, index, len(rows), "thumbnails")

        _maybe_progress(progress_cb, 0, len(rows), "grouping", force=True)
        eligible_ids = {
            int(row["id"])
            for row in manifest.conn.execute(
                """
                SELECT id
                FROM images
                WHERE COALESCE(is_quarantined, 0) = 0
                  AND (? = 1 OR COALESCE(keep_all, 0) = 0)
                  AND (? = 1 OR resolved_at IS NULL)
                """,
                (1 if include_keep_all else 0, 1 if include_keep_all else 0),
            )
        }
        groupables = [
            GroupableImage(
                id=row.id,
                phash=row.phash or "",
                dhash=row.dhash or "",
                histogram=row.histogram or [],
                quality_score=float(row.quality_score or 0.0),
            )
            for row in rows
            if row.id in eligible_ids and row.phash and row.dhash and row.histogram is not None
        ]
        groups = group_images(groupables, threshold=threshold, progress_cb=progress_cb)
        groups = manifest.filter_unevaluated_groups(groups)
        quality_scores = {row.id: float(row.quality_score or 0.0) for row in rows}
        keep_by_group = {
            group_id: choose_keep(members, quality_scores)
            for group_id, members in enumerate(groups, start=1)
        }
        manifest.replace_groups(groups, keep_by_group, threshold, preserve_resolved=not include_keep_all)
        manifest.set_meta("root_path", str(folder.resolve()))
        manifest.set_meta("threshold", str(threshold))
        manifest.set_meta("last_scan_at", utc_now())
        manifest.set_meta("cache_hits", str(cache_hits))
        manifest.set_meta("errors", str(errors))
        groups_total, duplicate_groups, reclaimable = manifest.summary()
        _maybe_progress(progress_cb, len(rows), len(rows), "done", force=True)
        return {
            "images": len(rows),
            "groups": groups_total,
            "duplicate_groups": duplicate_groups,
            "reclaimable_bytes": reclaimable,
            "cache_hits": cache_hits,
            "errors": errors,
        }
    finally:
        manifest.close()


def run_regroup(
    db_path: Path,
    threshold: int,
    progress_cb: ProgressCallback | None = None,
    include_keep_all: bool = False,
) -> dict[str, int]:
    if threshold < 0 or threshold > 100:
        raise ValueError("threshold must be between 0 and 100")
    manifest = Manifest(db_path)
    try:
        return manifest.regroup(threshold, progress_cb=progress_cb, include_keep_all=include_keep_all)
    finally:
        manifest.close()


def run_backfill_taken_at(db_path: Path, batch_size: int = 500) -> dict[str, int]:
    manifest = Manifest(db_path)
    try:
        return manifest.backfill_taken_at(batch_size=batch_size)
    finally:
        manifest.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="photodedup")
    sub = parser.add_subparsers(dest="command", required=True)
    scan = sub.add_parser("scan")
    scan.add_argument("folder", type=Path)
    scan.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD)
    scan.add_argument("--db", type=Path, default=Path("manifest.db"))
    scan.add_argument("--rescan", action="store_true")
    scan.add_argument("-v", "--verbose", action="store_true")
    regroup = sub.add_parser("regroup")
    regroup.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD)
    regroup.add_argument("--db", type=Path, default=Path("manifest.db"))
    regroup.add_argument("-v", "--verbose", action="store_true")
    dryrun = sub.add_parser("dryrun")
    dryrun.add_argument("--db", type=Path, default=Path("manifest.db"))
    dryrun.add_argument("--quarantine-root", type=Path, default=None)
    dryrun.add_argument("-v", "--verbose", action="store_true")
    quarantine = sub.add_parser("quarantine")
    quarantine.add_argument("--db", type=Path, default=Path("manifest.db"))
    quarantine.add_argument("--quarantine-root", type=Path, default=None)
    quarantine.add_argument("--yes", action="store_true")
    quarantine.add_argument("-v", "--verbose", action="store_true")
    restore = sub.add_parser("restore")
    restore.add_argument("--db", type=Path, default=Path("manifest.db"))
    selector = restore.add_mutually_exclusive_group(required=True)
    selector.add_argument("--date")
    selector.add_argument("--id", type=int)
    selector.add_argument("--all", action="store_true")
    restore.add_argument("-v", "--verbose", action="store_true")
    listed = sub.add_parser("list-quarantine")
    listed.add_argument("--db", type=Path, default=Path("manifest.db"))
    listed.add_argument("-v", "--verbose", action="store_true")
    backfill = sub.add_parser("backfill-taken-at")
    backfill.add_argument("--db", type=Path, default=Path("manifest.db"))
    backfill.add_argument("--batch-size", type=int, default=500)
    backfill.add_argument("-v", "--verbose", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
    if args.command == "scan":
        summary = run_scan(args.folder, args.db, args.threshold, args.rescan)
        print(
            "Scan complete: "
            f"images={summary['images']} "
            f"groups={summary['groups']} "
            f"duplicate_groups={summary['duplicate_groups']} "
            f"reclaimable={human_bytes(summary['reclaimable_bytes'])} "
            f"cache_hits={summary['cache_hits']}"
        )
        return 0
    if args.command == "regroup":
        summary = run_regroup(args.db, args.threshold)
        print(
            "Regroup complete: "
            f"images={summary['images']} "
            f"groups={summary['groups']} "
            f"duplicate_groups={summary['duplicate_groups']} "
            f"reclaimable={human_bytes(summary['reclaimable_bytes'])}"
        )
        return 0
    if args.command == "dryrun":
        quarantine_dir = dated_quarantine_dir(args.quarantine_root) if args.quarantine_root else None
        plan = build_dryrun_plan(args.db, quarantine_dir)
        summary = summarize_plan(plan)
        print(f"Dryrun: files={summary.count} bytes={summary.bytes} size={human_bytes(summary.bytes)}")
        print(plan_to_json(plan))
        return 0
    if args.command == "quarantine":
        quarantine_dir = dated_quarantine_dir(args.quarantine_root) if args.quarantine_root else None
        plan = build_dryrun_plan(args.db, quarantine_dir)
        summary = summarize_plan(plan)
        print(f"Quarantine plan: files={summary.count} bytes={summary.bytes} size={human_bytes(summary.bytes)}")
        print(plan_to_json(plan))
        if not args.yes:
            answer = input("Move files to quarantine? Type 'yes' to continue: ")
            if answer != "yes":
                print("Aborted.")
                return 1
        result = quarantine_plan(args.db, plan)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "restore":
        result = restore_quarantine(
            args.db,
            quarantine_id=args.id,
            date=args.date,
            restore_all=args.all,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "list-quarantine":
        print(json.dumps(list_quarantine(args.db), ensure_ascii=False, indent=2))
        return 0
    if args.command == "backfill-taken-at":
        summary = run_backfill_taken_at(args.db, batch_size=args.batch_size)
        print(
            "Backfill taken_at complete: "
            f"checked={summary['checked']} "
            f"updated={summary['updated']} "
            f"local={summary['local']} "
            f"missing={summary['missing']} "
            f"failed={summary['failed']}"
        )
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
