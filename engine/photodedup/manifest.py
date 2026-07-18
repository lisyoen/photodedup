from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
from pathlib import Path
import sqlite3
from typing import Callable

from .grouping import GroupableImage, group_images
from .quality import choose_keep
from .scanner import ImageFile, _mtime_iso, taken_at_for_path

ProgressCallback = Callable[[int, int, str], None]
LOGGER = logging.getLogger(__name__)


@dataclass
class CachedImage:
    id: int
    path: Path
    size_bytes: int
    mtime: float
    taken_at: str | None
    width: int
    height: int
    format: str
    sharpness: float | None
    phash: str | None
    dhash: str | None
    quality_score: float | None
    thumb_path: str | None
    histogram: list[float] | None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Manifest:
    def __init__(self, db_path: Path, *, run_migrations: bool = True) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, timeout=30.0)
        self.conn.execute("PRAGMA busy_timeout = 5000")
        self.conn.row_factory = sqlite3.Row
        if run_migrations:
            self.init_schema()

    def close(self) -> None:
        self.conn.close()

    def init_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS images(
                id INTEGER PRIMARY KEY,
                path TEXT UNIQUE,
                size_bytes INT,
                mtime REAL,
                taken_at TEXT,
                width INT,
                height INT,
                format TEXT,
                sharpness REAL,
                phash TEXT,
                dhash TEXT,
                quality_score REAL,
                thumb_path TEXT,
                group_id INT,
                is_keep INT DEFAULT 0,
                scanned_at TEXT,
                resolved_at TEXT
            );
            CREATE TABLE IF NOT EXISTS groups(
                group_id INTEGER PRIMARY KEY,
                member_count INT,
                keep_image_id INT,
                reclaimable_bytes INT,
                threshold INT,
                created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS scan_meta(
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS evaluated_groups(
                signature TEXT PRIMARY KEY,
                member_count INTEGER,
                evaluated_at TEXT,
                root_hint TEXT
            );
            CREATE TABLE IF NOT EXISTS image_histograms(
                image_id INTEGER PRIMARY KEY,
                histogram TEXT NOT NULL,
                FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS quarantine(
                id INTEGER PRIMARY KEY,
                image_id INT,
                original_path TEXT,
                quarantine_path TEXT,
                size INT,
                phash TEXT,
                group_id INT,
                moved_at TEXT,
                restored_at TEXT,
                status TEXT,
                FOREIGN KEY(image_id) REFERENCES images(id)
            );
            """
        )
        columns = {row["name"] for row in self.conn.execute("PRAGMA table_info(images)")}
        if "taken_at" not in columns:
            self.conn.execute("ALTER TABLE images ADD COLUMN taken_at TEXT")
        if "is_quarantined" not in columns:
            self.conn.execute("ALTER TABLE images ADD COLUMN is_quarantined INT DEFAULT 0")
        if "keep_all" not in columns:
            self.conn.execute("ALTER TABLE images ADD COLUMN keep_all INT DEFAULT 0")
        if "resolved_at" not in columns:
            self.conn.execute("ALTER TABLE images ADD COLUMN resolved_at TEXT")
        if "mark" not in columns:
            self.conn.execute("ALTER TABLE images ADD COLUMN mark TEXT")
        group_columns = {row["name"] for row in self.conn.execute("PRAGMA table_info(groups)")}
        if "keep_all" not in group_columns:
            self.conn.execute("ALTER TABLE groups ADD COLUMN keep_all INT DEFAULT 0")
        if "resolved_at" not in group_columns:
            self.conn.execute("ALTER TABLE groups ADD COLUMN resolved_at TEXT")
        self._ensure_resolved_group_rows()
        self.backfill_quarantined_resolved_at()
        self.backfill_keep_all_is_keep()
        self.mark_residual_zero_byte_groups()
        self.conn.commit()

    def backfill_quarantined_resolved_at(self) -> int:
        cursor = self.conn.execute(
            """
            UPDATE images
            SET resolved_at = ?
            WHERE COALESCE(is_quarantined, 0) = 1
              AND resolved_at IS NULL
            """,
            (utc_now(),),
        )
        count = int(cursor.rowcount or 0)
        if count > 0:
            LOGGER.warning("backfill resolved_at: %s rows", count)
        return count

    def backfill_keep_all_is_keep(self) -> int:
        cursor = self.conn.execute(
            """
            UPDATE images
            SET is_keep = 1
            WHERE COALESCE(is_quarantined, 0) = 0
              AND group_id IN (
                SELECT group_id
                FROM groups
                WHERE COALESCE(keep_all, 0) = 1
              )
              AND COALESCE(is_keep, 0) = 0
            """
        )
        return int(cursor.rowcount or 0)

    def mark_residual_zero_byte_groups(self) -> int:
        now = utc_now()
        cursor = self.conn.execute(
            """
            UPDATE groups
            SET resolved_at = ?
            WHERE resolved_at IS NULL
              AND (
                (
                  SELECT COUNT(*)
                  FROM images i
                  WHERE i.group_id = groups.group_id
                    AND i.resolved_at IS NULL
                    AND COALESCE(i.is_quarantined, 0) = 0
                ) < 2
                OR (
                  COALESCE(reclaimable_bytes, 0) = 0
                  AND NOT EXISTS (
                    SELECT 1
                    FROM images d
                    WHERE d.group_id = groups.group_id
                      AND d.resolved_at IS NULL
                      AND COALESCE(d.is_quarantined, 0) = 0
                      AND d.mark = 'delete'
                  )
                )
              )
            """,
            (now,),
        )
        count = int(cursor.rowcount or 0)
        if count > 0:
            LOGGER.warning("marked residual 0-byte groups resolved: %s rows", count)
        return count

    def _ensure_resolved_group_rows(self) -> None:
        rows = self.conn.execute(
            """
            SELECT i.group_id, COUNT(*) AS member_count
            FROM images i
            LEFT JOIN groups g ON g.group_id = i.group_id
            WHERE i.group_id IS NOT NULL
              AND i.resolved_at IS NOT NULL
              AND g.group_id IS NULL
            GROUP BY i.group_id
            HAVING COUNT(*) > 1
            """
        ).fetchall()
        if not rows:
            return
        threshold_row = self.conn.execute("SELECT value FROM scan_meta WHERE key = 'threshold'").fetchone()
        try:
            threshold = int(threshold_row["value"]) if threshold_row and threshold_row["value"] is not None else 0
        except ValueError:
            threshold = 0
        now = utc_now()
        for row in rows:
            group_id = int(row["group_id"])
            keep = self.conn.execute(
                """
                SELECT id
                FROM images
                WHERE group_id = ?
                ORDER BY COALESCE(is_keep, 0) DESC,
                         COALESCE(is_quarantined, 0) ASC,
                         COALESCE(quality_score, 0) DESC,
                         id ASC
                LIMIT 1
                """,
                (group_id,),
            ).fetchone()
            keep_image_id = int(keep["id"]) if keep else None
            self.conn.execute(
                """
                INSERT OR IGNORE INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
                VALUES (?, ?, ?, 0, ?, ?)
                """,
                (group_id, int(row["member_count"]), keep_image_id, threshold, now),
            )

    def cache_lookup(self, image: ImageFile) -> CachedImage | None:
        row = self.conn.execute(
            """
            SELECT i.*, h.histogram
            FROM images i
            LEFT JOIN image_histograms h ON h.image_id = i.id
            WHERE i.path = ? AND i.mtime = ? AND i.size_bytes = ?
            """,
            (str(image.path), image.mtime, image.size_bytes),
        ).fetchone()
        if row is None:
            return None
        histogram = json.loads(row["histogram"]) if row["histogram"] else None
        return CachedImage(
            id=int(row["id"]),
            path=Path(row["path"]),
            size_bytes=int(row["size_bytes"]),
            mtime=float(row["mtime"]),
            taken_at=row["taken_at"],
            width=int(row["width"]),
            height=int(row["height"]),
            format=row["format"],
            sharpness=row["sharpness"],
            phash=row["phash"],
            dhash=row["dhash"],
            quality_score=row["quality_score"],
            thumb_path=row["thumb_path"],
            histogram=histogram,
        )

    def upsert_image(
        self,
        image: ImageFile,
        *,
        sharpness: float | None,
        phash: str | None,
        dhash: str | None,
        quality_score: float | None,
        histogram: list[float] | None,
    ) -> CachedImage:
        scanned_at = utc_now()
        self.conn.execute(
            """
            INSERT INTO images(path, size_bytes, mtime, taken_at, width, height, format, sharpness,
                               phash, dhash, quality_score, scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                size_bytes=excluded.size_bytes,
                mtime=excluded.mtime,
                taken_at=excluded.taken_at,
                width=excluded.width,
                height=excluded.height,
                format=excluded.format,
                sharpness=excluded.sharpness,
                phash=excluded.phash,
                dhash=excluded.dhash,
                quality_score=excluded.quality_score,
                scanned_at=excluded.scanned_at
            """,
            (
                str(image.path),
                image.size_bytes,
                image.mtime,
                image.taken_at,
                image.width,
                image.height,
                image.format,
                sharpness,
                phash,
                dhash,
                quality_score,
                scanned_at,
            ),
        )
        row = self.conn.execute("SELECT * FROM images WHERE path = ?", (str(image.path),)).fetchone()
        assert row is not None
        if histogram is not None:
            self.conn.execute(
                """
                INSERT INTO image_histograms(image_id, histogram)
                VALUES (?, ?)
                ON CONFLICT(image_id) DO UPDATE SET histogram=excluded.histogram
                """,
                (int(row["id"]), json.dumps(histogram)),
            )
        self.conn.commit()
        return self.cache_lookup(image)  # type: ignore[return-value]

    def backfill_taken_at(self, batch_size: int = 500) -> dict[str, int]:
        rows = self.conn.execute(
            """
            SELECT id, path, mtime
            FROM images
            WHERE taken_at IS NULL
            ORDER BY id ASC
            """
        ).fetchall()
        updated = 0
        local = 0
        missing = 0
        failed = 0
        for row in rows:
            path = Path(row["path"])
            mtime = row["mtime"]
            if path.exists():
                local += 1
                taken_at = taken_at_for_path(path, mtime)
            else:
                missing += 1
                taken_at = _mtime_iso(mtime)
            if not taken_at:
                failed += 1
                continue
            self.conn.execute("UPDATE images SET taken_at = ? WHERE id = ?", (taken_at, int(row["id"])))
            updated += 1
            if updated % batch_size == 0:
                self.conn.commit()
        self.conn.commit()
        return {
            "checked": len(rows),
            "updated": updated,
            "local": local,
            "missing": missing,
            "failed": failed,
        }

    def set_thumb(self, image_id: int, thumb_path: Path) -> None:
        self.conn.execute("UPDATE images SET thumb_path = ? WHERE id = ?", (str(thumb_path), image_id))
        self.conn.commit()

    def replace_groups(
        self,
        groups: list[list[int]],
        keep_by_group: dict[int, int],
        threshold: int,
        preserve_keep_all: bool = True,
        preserve_resolved: bool = True,
    ) -> None:
        now = utc_now()
        if preserve_keep_all:
            self.conn.execute(
                """
                DELETE FROM groups
                WHERE COALESCE(keep_all, 0) = 0
                  AND (
                    ? = 0
                    OR NOT EXISTS (
                        SELECT 1
                        FROM images i
                        WHERE i.group_id = groups.group_id
                          AND i.resolved_at IS NOT NULL
                    )
                  )
                """,
                (1 if preserve_resolved else 0,),
            )
            self.conn.execute(
                """
                UPDATE images
                SET group_id = NULL, is_keep = 0
                WHERE COALESCE(keep_all, 0) = 0
                  AND (? = 0 OR resolved_at IS NULL)
                  AND (
                    ? = 0
                    OR group_id IS NULL
                    OR group_id NOT IN (
                      SELECT DISTINCT group_id
                      FROM images
                      WHERE resolved_at IS NOT NULL
                        AND group_id IS NOT NULL
                    )
                  )
                """,
                (1 if preserve_resolved else 0, 1 if preserve_resolved else 0),
            )
            start_group_id = int(
                self.conn.execute("SELECT COALESCE(MAX(group_id), 0) + 1 FROM groups").fetchone()[0]
            )
        else:
            self.conn.execute("DELETE FROM groups")
            self.conn.execute("UPDATE images SET group_id = NULL, is_keep = 0")
            start_group_id = 1
        for offset, members in enumerate(groups):
            group_id = start_group_id + offset
            keep_id = keep_by_group[offset + 1]
            sizes = {
                int(row["id"]): int(row["size_bytes"])
                for row in self.conn.execute(
                    f"SELECT id, size_bytes FROM images WHERE id IN ({','.join('?' for _ in members)})",
                    tuple(members),
                )
            }
            reclaimable = sum(size for image_id, size in sizes.items() if image_id != keep_id)
            resolved_at = self.evaluated_at_for_group_members(members)
            self.conn.execute(
                """
                INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at, resolved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (group_id, len(members), keep_id, reclaimable, threshold, now, resolved_at),
            )
            for image_id in members:
                self.conn.execute(
                    "UPDATE images SET group_id = ?, is_keep = ?, mark = ? WHERE id = ?",
                    (group_id, 1 if image_id == keep_id else 0, "none", image_id),
                )
        self.conn.execute(
            "INSERT INTO scan_meta(key, value) VALUES ('last_regroup_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (now,),
        )
        self.conn.commit()

    def regroup(
        self,
        threshold: int,
        progress_cb: ProgressCallback | None = None,
        include_keep_all: bool = False,
    ) -> dict[str, int]:
        if include_keep_all:
            self.conn.execute("UPDATE images SET keep_all = 0")
            self.conn.execute("UPDATE groups SET keep_all = 0")
            self.conn.commit()
        rows = self.conn.execute(
            """
            SELECT i.id, i.quality_score, i.phash, i.dhash, h.histogram
            FROM images i
            LEFT JOIN image_histograms h ON h.image_id = i.id
            WHERE COALESCE(i.is_quarantined, 0) = 0
              AND (? = 1 OR COALESCE(i.keep_all, 0) = 0)
              AND (? = 1 OR i.resolved_at IS NULL)
              AND i.phash IS NOT NULL
              AND i.dhash IS NOT NULL
              AND h.histogram IS NOT NULL
            ORDER BY i.id ASC
            """
            ,
            (1 if include_keep_all else 0, 1 if include_keep_all else 0),
        ).fetchall()
        total = len(rows)
        if progress_cb:
            progress_cb(0, total, "grouping")
        groupables = []
        step = max(1, total // 100) if total else 1
        for index, row in enumerate(rows, start=1):
            groupables.append(
                GroupableImage(
                    id=int(row["id"]),
                    phash=row["phash"],
                    dhash=row["dhash"],
                    histogram=json.loads(row["histogram"]),
                    quality_score=float(row["quality_score"] or 0.0),
                )
            )
            if progress_cb and (index == total or index % 50 == 0 or index % step == 0):
                progress_cb(index, total, "grouping")
        groups = group_images(groupables, threshold=threshold, progress_cb=progress_cb)
        quality_scores = {item.id: item.quality_score for item in groupables}
        keep_by_group = {
            group_id: choose_keep(members, quality_scores)
            for group_id, members in enumerate(groups, start=1)
        }
        self.replace_groups(groups, keep_by_group, threshold, preserve_resolved=not include_keep_all)
        self.set_meta("threshold", str(threshold))
        self.set_meta("last_regroup_at", utc_now())
        groups_total, duplicate_groups, reclaimable = self.summary()
        if progress_cb:
            progress_cb(total, total, "done")
        return {
            "images": len(groupables),
            "groups": groups_total,
            "duplicate_groups": duplicate_groups,
            "reclaimable_bytes": reclaimable,
        }

    def group_signature_for_members(self, member_ids: list[int]) -> str | None:
        unique_ids = list(dict.fromkeys(int(image_id) for image_id in member_ids))
        if not unique_ids:
            return None
        placeholders = ",".join("?" for _ in unique_ids)
        rows = self.conn.execute(
            f"""
            SELECT id, phash, dhash, size_bytes
            FROM images
            WHERE id IN ({placeholders})
            """,
            tuple(unique_ids),
        ).fetchall()
        if len(rows) != len(unique_ids):
            return None
        parts = []
        for row in rows:
            if row["phash"] is None or row["dhash"] is None:
                return None
            parts.append(f"{row['phash']}:{row['dhash']}:{int(row['size_bytes'] or 0)}")
        digest_source = "|".join(sorted(parts))
        return hashlib.sha1(digest_source.encode("utf-8")).hexdigest()

    def group_signature_for_group_id(self, group_id: int) -> str | None:
        rows = self.conn.execute(
            "SELECT id FROM images WHERE group_id = ? ORDER BY id ASC",
            (int(group_id),),
        ).fetchall()
        return self.group_signature_for_members([int(row["id"]) for row in rows])

    def is_evaluated_group_members(self, member_ids: list[int]) -> bool:
        return self.evaluated_at_for_group_members(member_ids) is not None

    def evaluated_at_for_group_members(self, member_ids: list[int]) -> str | None:
        signature = self.group_signature_for_members(member_ids)
        if signature is None:
            return None
        row = self.conn.execute(
            "SELECT evaluated_at FROM evaluated_groups WHERE signature = ?",
            (signature,),
        ).fetchone()
        return str(row["evaluated_at"]) if row and row["evaluated_at"] is not None else None

    def filter_unevaluated_groups(self, groups: list[list[int]]) -> list[list[int]]:
        marked = sum(1 for members in groups if self.is_evaluated_group_members(members))
        if marked > 0:
            LOGGER.info("preserved evaluated groups as resolved during regroup: %s", marked)
        return groups

    def record_evaluated_group(self, group_id: int, *, evaluated_at: str | None = None) -> str | None:
        signature = self.group_signature_for_group_id(group_id)
        if signature is None:
            return None
        rows = self.conn.execute(
            "SELECT path FROM images WHERE group_id = ? ORDER BY id ASC",
            (int(group_id),),
        ).fetchall()
        root_hint = str(Path(rows[0]["path"]).parent) if rows else None
        self.conn.execute(
            """
            INSERT OR REPLACE INTO evaluated_groups(signature, member_count, evaluated_at, root_hint)
            VALUES (?, ?, ?, ?)
            """,
            (signature, len(rows), evaluated_at or utc_now(), root_hint),
        )
        return signature

    def mark_group_resolved(self, group_id: int, *, resolved_at: str | None = None) -> None:
        self.conn.execute(
            "UPDATE groups SET resolved_at = COALESCE(resolved_at, ?) WHERE group_id = ?",
            (resolved_at or utc_now(), int(group_id)),
        )

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO scan_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        self.conn.commit()

    def summary(self) -> tuple[int, int, int]:
        row = self.conn.execute(
            """
            SELECT COUNT(*) AS groups_total,
                   SUM(CASE WHEN member_count > 1 THEN 1 ELSE 0 END) AS dup_groups,
                   COALESCE(SUM(reclaimable_bytes), 0) AS reclaimable
            FROM groups
            """
        ).fetchone()
        return int(row["groups_total"]), int(row["dup_groups"] or 0), int(row["reclaimable"] or 0)
