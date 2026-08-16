from __future__ import annotations

from pathlib import Path
import sqlite3

import pytest

from photodedup import cleanup
from photodedup.api import create_app
from photodedup.cleanup import (
    CleanupPlanItem,
    QUARANTINE_MARKER_NAME,
    quarantine_plan,
)
from photodedup.manifest import Manifest


def _seed_image(db_path: Path, image_id: int, source: Path) -> None:
    manifest = Manifest(db_path)
    try:
        manifest.conn.execute(
            "INSERT INTO images(id, path, size_bytes, mtime, width, height, format, is_keep) VALUES (?, ?, ?, 0, 1, 1, 'jpg', 0)",
            (image_id, str(source), source.stat().st_size),
        )
        manifest.conn.commit()
    finally:
        manifest.close()


def _plan(image_id: int, source: Path, target: Path) -> CleanupPlanItem:
    return CleanupPlanItem(image_id, source, target, source.stat().st_size, None, None)


def test_quarantine_records_pending_before_move_then_commits_success(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "data" / "manifest.db"
    source = tmp_path / "photos" / "a.jpg"
    source.parent.mkdir()
    source.write_bytes(b"photo")
    target = tmp_path / "data" / "trash" / "20260816" / source.name
    _seed_image(db_path, 1, source)
    real_move = cleanup.shutil.move

    def verify_intent_then_move(src: str, dst: str) -> str:
        with sqlite3.connect(db_path) as observer:
            status = observer.execute("SELECT status FROM quarantine WHERE image_id = 1").fetchone()[0]
        assert status == "pending_move"
        return real_move(src, dst)

    monkeypatch.setattr(cleanup.shutil, "move", verify_intent_then_move)
    assert quarantine_plan(db_path, [_plan(1, source, target)]) == {"quarantined": 1, "failed": 0, "skipped": 0}

    manifest = Manifest(db_path, run_migrations=False)
    try:
        row = manifest.conn.execute("SELECT status, moved_at FROM quarantine WHERE image_id = 1").fetchone()
        assert (row["status"], row["moved_at"] is not None) == ("quarantined", True)
        assert manifest.conn.execute("SELECT is_quarantined FROM images WHERE id = 1").fetchone()[0] == 1
    finally:
        manifest.close()
    assert target.exists() and not source.exists()


def test_quarantine_move_failure_marks_failed_and_preserves_source(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "data" / "manifest.db"
    source = tmp_path / "photos" / "a.jpg"
    source.parent.mkdir()
    source.write_bytes(b"photo")
    target = tmp_path / "data" / "trash" / "20260816" / source.name
    _seed_image(db_path, 1, source)

    def fail_move(src: str, dst: str) -> str:
        raise PermissionError("denied")

    monkeypatch.setattr(cleanup.shutil, "move", fail_move)
    assert quarantine_plan(db_path, [_plan(1, source, target)]) == {"quarantined": 0, "failed": 1, "skipped": 0}
    assert source.exists() and not target.exists()
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT status FROM quarantine WHERE image_id = 1").fetchone()[0] == "failed"
        assert conn.execute("SELECT is_quarantined FROM images WHERE id = 1").fetchone()[0] == 0


def test_quarantine_does_not_move_when_pending_commit_fails(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "data" / "manifest.db"
    source = tmp_path / "photos" / "a.jpg"
    source.parent.mkdir()
    source.write_bytes(b"photo")
    target = tmp_path / "data" / "trash" / "20260816" / source.name
    _seed_image(db_path, 1, source)
    move_called = False

    def fail_intent(*args, **kwargs) -> int:
        raise sqlite3.OperationalError("database is locked")

    def observe_move(src: str, dst: str) -> str:
        nonlocal move_called
        move_called = True
        return dst

    monkeypatch.setattr(cleanup, "_record_quarantine", fail_intent)
    monkeypatch.setattr(cleanup.shutil, "move", observe_move)
    with pytest.raises(sqlite3.OperationalError, match="locked"):
        quarantine_plan(db_path, [_plan(1, source, target)])

    assert move_called is False
    assert source.exists() and not target.exists()


def test_reconcile_pending_quarantine_all_three_branches(tmp_path: Path, caplog) -> None:
    db_path = tmp_path / "data" / "manifest.db"
    manifest = Manifest(db_path)
    originals = [tmp_path / f"original-{index}.jpg" for index in range(3)]
    targets = [tmp_path / f"quarantine-{index}.jpg" for index in range(3)]
    targets[0].write_bytes(b"moved")
    originals[1].write_bytes(b"not moved")
    for index in range(3):
        manifest.conn.execute(
            "INSERT INTO images(id, path, size_bytes, mtime, width, height, format) VALUES (?, ?, 1, 0, 1, 1, 'jpg')",
            (index + 1, str(originals[index])),
        )
        manifest.conn.execute(
            "INSERT INTO quarantine(image_id, original_path, quarantine_path, size, status) VALUES (?, ?, ?, 1, 'pending_move')",
            (index + 1, str(originals[index]), str(targets[index])),
        )
    manifest.conn.commit()

    counts = manifest.reconcile_pending_quarantine()
    statuses = [row[0] for row in manifest.conn.execute("SELECT status FROM quarantine ORDER BY image_id")]
    manifest.close()

    assert counts == {"quarantined": 1, "failed": 1, "lost": 1}
    assert statuses == ["quarantined", "failed", "lost"]
    assert "pending quarantine lost" in caplog.text
    assert "quarantined=1 failed=1 lost=1" in caplog.text


def test_create_app_creates_protected_trash_under_data_dir(tmp_path: Path) -> None:
    data_dir = tmp_path / "engine-data"
    create_app(data_dir, "token")
    marker = data_dir / "trash" / QUARANTINE_MARKER_NAME
    assert marker.exists()
    content = marker.read_text(encoding="utf-8")
    assert "복구" in content
    assert "recovery" in content
    assert not (tmp_path / "trash").exists()
