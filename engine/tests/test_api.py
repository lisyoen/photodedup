from __future__ import annotations

from pathlib import Path
import json
import sqlite3
import threading
import time

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageEnhance
import pytest

from photodedup import api as api_module
from photodedup.api import create_app
from photodedup.scanner import ImageFile, ScanFolderResult, ScanStats
from photodedup.manifest import Manifest, utc_now


TOKEN = "test-token"


def _write_sample_images(root: Path) -> None:
    image_a = Image.new("RGB", (128, 128), "#234f9a")
    draw = ImageDraw.Draw(image_a)
    draw.rectangle((18, 18, 104, 104), fill="#f5c542")
    draw.ellipse((42, 42, 92, 92), fill="#cf335f")
    image_a.save(root / "a.jpg", quality=95)

    image_a_prime = image_a.resize((96, 96)).resize((128, 128))
    image_a_prime = ImageEnhance.Brightness(image_a_prime).enhance(1.04)
    image_a_prime.save(root / "a_prime.jpg", quality=92)

    image_b = Image.new("RGB", (128, 128), "#ffffff")
    draw_b = ImageDraw.Draw(image_b)
    for offset in range(0, 128, 8):
        color = "#111111" if offset % 16 == 0 else "#2ca58d"
        draw_b.line((0, offset, 127, 127 - offset), fill=color, width=3)
    image_b.save(root / "b.jpg", quality=95)


def _client(data_dir: Path) -> TestClient:
    return TestClient(create_app(data_dir, TOKEN), headers={"X-Api-Token": TOKEN})


def test_api_request_manifests_skip_migrations(tmp_path: Path, monkeypatch) -> None:
    calls: list[bool] = []
    original_manifest = api_module.Manifest

    class TrackingManifest(original_manifest):
        def __init__(self, db_path: Path, *, run_migrations: bool = True) -> None:
            calls.append(run_migrations)
            super().__init__(db_path, run_migrations=run_migrations)

    monkeypatch.setattr(api_module, "Manifest", TrackingManifest)
    client = TestClient(api_module.create_app(tmp_path / "data", TOKEN), headers={"X-Api-Token": TOKEN})

    assert client.get("/healthz").status_code == 200
    assert client.get("/groups").status_code == 200
    assert calls == [True, False, False]


def test_create_app_runs_one_startup_migration_with_complete_schema(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    client = _client(data_dir)
    assert client.get("/healthz").status_code == 200
    assert client.get("/groups").status_code == 200

    conn = sqlite3.connect(data_dir / "manifest.db")
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        image_columns = {row[1] for row in conn.execute("PRAGMA table_info(images)")}
        group_columns = {row[1] for row in conn.execute("PRAGMA table_info(groups)")}
    finally:
        conn.close()

    assert {"images", "groups", "scan_meta", "evaluated_groups", "image_histograms", "quarantine"} <= tables
    assert {"taken_at", "is_quarantined", "keep_all", "resolved_at", "mark"} <= image_columns
    assert {"keep_all", "resolved_at"} <= group_columns


def test_manifest_sets_busy_timeout_pragma(tmp_path: Path) -> None:
    manifest = Manifest(tmp_path / "data" / "manifest.db")
    try:
        assert manifest.conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    finally:
        manifest.close()


def test_manifest_waits_for_temporary_write_lock(tmp_path: Path) -> None:
    db_path = tmp_path / "data" / "manifest.db"
    seed = Manifest(db_path)
    seed.close()

    blocker = sqlite3.connect(db_path, timeout=30.0, check_same_thread=False)
    blocker.execute("PRAGMA busy_timeout = 5000")
    blocker.execute("BEGIN EXCLUSIVE")
    blocker.execute("INSERT INTO scan_meta(key, value) VALUES ('lock-holder', '1')")

    def release_lock() -> None:
        time.sleep(0.2)
        blocker.commit()
        blocker.close()

    releaser = threading.Thread(target=release_lock)
    releaser.start()
    started_at = time.monotonic()
    manifest = Manifest(db_path, run_migrations=False)
    try:
        value = manifest.conn.execute("SELECT value FROM scan_meta WHERE key = 'lock-holder'").fetchone()[0]
    finally:
        manifest.close()
        releaser.join()

    assert value == "1"
    assert time.monotonic() - started_at >= 0.15


def test_groups_requires_token(tmp_path: Path) -> None:
    client = TestClient(create_app(tmp_path, TOKEN))
    response = client.get("/groups")
    assert response.status_code == 401


def test_groups_rejects_wrong_token(tmp_path: Path) -> None:
    client = TestClient(create_app(tmp_path, TOKEN))
    response = client.get("/groups", headers={"X-Api-Token": "wrong"})
    assert response.status_code == 401


def test_healthz_without_token(tmp_path: Path) -> None:
    client = TestClient(create_app(tmp_path, TOKEN))
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_healthz_reports_manifest_counts(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    client = _client(data_dir)

    empty = client.get("/healthz")
    assert empty.status_code == 200
    assert empty.json()["images"] == 0
    assert empty.json()["groups"] == 0

    manifest = Manifest(data_dir / "manifest.db", run_migrations=False)
    try:
        manifest.conn.execute(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (1, 2, 1, 100, 90, ?)
            """,
            (utc_now(),),
        )
        manifest.conn.execute(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark)
            VALUES
              (1, 'C:\\Photos\\a.jpg', 100, 1.0, 10, 10, 'jpg', 80, 1, 'none'),
              (2, 'C:\\Photos\\b.jpg', 90, 1.0, 10, 10, 'jpg', 70, 1, 'none')
            """
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    populated = client.get("/healthz")
    assert populated.status_code == 200
    assert populated.json()["images"] == 2
    assert populated.json()["groups"] == 1


def test_full_image_streams_original_file(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    image_path = tmp_path / "full.jpg"
    Image.new("RGB", (24, 16), "#112233").save(image_path, quality=90)
    manifest = Manifest(data_dir / "manifest.db")
    try:
        manifest.conn.execute(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, mark)
            VALUES (1, ?, ?, 1.0, 24, 16, 'jpg', 80, 'none')
            """,
            (str(image_path), image_path.stat().st_size),
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    response = _client(data_dir).get("/images/1/full")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/jpeg")
    assert response.content == image_path.read_bytes()


def test_full_image_returns_404_for_missing_id(tmp_path: Path) -> None:
    response = _client(tmp_path / "data").get("/images/999/full")

    assert response.status_code == 404


def test_scan_fixture_folder_and_list_groups(tmp_path: Path) -> None:
    images = tmp_path / "images"
    images.mkdir()
    _write_sample_images(images)
    client = _client(tmp_path / "data")

    started = client.post("/scan", json={"roots": [str(images)], "threshold": 88})
    assert started.status_code == 202
    scan_id = started.json()["scan_id"]
    status = _wait_scan(client, scan_id)
    assert status["status"] == "done"

    groups = client.get("/groups").json()
    assert groups["items"]
    assert groups["items"][0]["member_count"] >= 2
    assert groups["items"][0]["cover_image_id"] == groups["items"][0]["thumbnail_image_id"]
    assert "marked_count" in groups["items"][0]
    assert groups["items"][0]["total_count"] >= 2
    assert all(item["member_count"] >= 2 for item in groups["items"])

    manifest = Manifest(tmp_path / "data" / "manifest.db")
    try:
        ungrouped = manifest.conn.execute(
            "SELECT id FROM images WHERE path LIKE ? AND group_id IS NULL",
            (f"%{Path('b.jpg')}",),
        ).fetchall()
        assert len(ungrouped) == 1
    finally:
        manifest.close()


def test_scan_results_restore_from_manifest_after_engine_restart(tmp_path: Path) -> None:
    images = tmp_path / "images"
    images.mkdir()
    _write_sample_images(images)
    data_dir = tmp_path / "data"
    first_client = _client(data_dir)

    started = first_client.post("/scan", json={"roots": [str(images)], "threshold": 88})
    assert started.status_code == 202
    first_status = _wait_scan(first_client, started.json()["scan_id"])
    assert first_status["status"] == "done"

    restarted_client = _client(data_dir)
    health = restarted_client.get("/healthz")
    groups = restarted_client.get("/groups")

    assert health.status_code == 200
    assert Path(health.json()["db_path"]) == data_dir / "manifest.db"
    assert groups.status_code == 200
    assert groups.json()["total_estimate"] > 0
    assert groups.json()["items"][0]["member_count"] >= 2


def test_scan_writes_group_snapshot_and_restart_loads_it(tmp_path: Path) -> None:
    images = tmp_path / "images"
    images.mkdir()
    _write_sample_images(images)
    data_dir = tmp_path / "data"
    client = _client(data_dir)

    started = client.post("/scan", json={"roots": [str(images)], "threshold": 88})
    assert started.status_code == 202
    status = _wait_scan(client, started.json()["scan_id"])
    assert status["status"] == "done"

    snapshot_files = list((data_dir / "cache").glob("groups-*.json"))
    assert len(snapshot_files) == 1

    restarted_client = _client(data_dir)
    snapshot = restarted_client.get("/groups/snapshot", params={"roots": str(images)})

    assert snapshot.status_code == 200
    payload = snapshot.json()
    assert payload["version"] == 1
    assert payload["roots"] == [str(images)]
    assert len(payload["items"]) > 0
    assert payload["items"][0]["group"]["member_count"] >= 2


def test_cache_info_and_clear_only_remove_group_snapshots(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    cache_dir = data_dir / "cache"
    thumbs_dir = data_dir / "thumbs"
    client = _client(data_dir)
    cache_dir.mkdir(parents=True)
    thumbs_dir.mkdir(parents=True)
    snapshot_a = cache_dir / "groups-a.json"
    snapshot_b = cache_dir / "groups-b.json"
    completion_path = cache_dir / "group-completions.json"
    manifest_path = data_dir / "manifest.db"
    thumb_path = thumbs_dir / "1.jpg"
    snapshot_a.write_text("alpha", encoding="utf-8")
    snapshot_b.write_text("bravo", encoding="utf-8")
    completion_path.write_text(json.dumps({"completed_group_ids": [1]}), encoding="utf-8")
    thumb_path.write_text("thumb sentinel", encoding="utf-8")

    info = client.get("/cache/info")
    cleared = client.post("/cache/clear")
    after = client.get("/cache/info")

    assert info.status_code == 200
    assert info.json() == {
        "cache_dir": str(cache_dir),
        "snapshot_count": 2,
        "snapshot_bytes": len("alpha") + len("bravo"),
    }
    assert cleared.status_code == 200
    assert cleared.json() == {"removed": 2}
    assert after.json()["snapshot_count"] == 0
    assert not snapshot_a.exists()
    assert not snapshot_b.exists()
    assert completion_path.exists()
    assert json.loads(completion_path.read_text(encoding="utf-8"))["completed_group_ids"] == [1]
    assert manifest_path.exists()
    assert thumb_path.exists()


def test_new_scan_groups_start_uncompleted_without_user_marks(tmp_path: Path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    _seed_sort_group(data_dir, keep_image_id=1)
    manifest = Manifest(data_dir / "manifest.db")
    try:
        api_module._write_group_snapshot(data_dir / "cache", manifest, ["C:\\Photos"])
    finally:
        manifest.close()

    client = _client(data_dir)
    detail = client.get("/groups/1").json()

    assert detail["group"]["completed"] is False
    assert detail["group"]["marked_count"] == 0
    assert [image["mark"] for image in detail["images"]] == ["none", "none", "none", "none"]
    assert not (data_dir / "cache" / "group-completions.json").exists()


def test_image_mark_persists_group_completion_and_restart_restores_it(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _seed_sort_group(data_dir, keep_image_id=1)
    client = _client(data_dir)

    before = client.get("/groups/1").json()
    assert before["group"]["completed"] is False

    marked = client.patch("/images/3", json={"mark": "delete"})
    assert marked.status_code == 200

    completion_path = data_dir / "cache" / "group-completions.json"
    assert completion_path.exists()
    assert completion_path.read_text(encoding="utf-8").count("1") >= 1
    assert client.get("/groups/1").json()["group"]["completed"] is True

    restarted_client = _client(data_dir)
    restored = restarted_client.get("/groups/1").json()
    assert restored["group"]["completed"] is True


def test_group_action_persists_group_completion(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _seed_sort_group(data_dir, keep_image_id=1)
    client = _client(data_dir)

    response = client.post("/groups/1/action", json={"action": "apply_recommended"})

    assert response.status_code == 200
    detail = response.json()
    assert detail["group"]["completed"] is True
    assert {image["id"]: image["mark"] for image in detail["images"]} == {
        1: "keep",
        2: "delete",
        3: "delete",
        4: "delete",
    }
    assert client.get("/groups/1").json()["group"]["completed"] is True


def test_apply_recommended_preserves_manual_keep_marks(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _seed_sort_group(data_dir, keep_image_id=1)
    client = _client(data_dir)

    assert client.patch("/images/2", json={"mark": "keep"}).status_code == 200
    assert client.patch("/images/3", json={"mark": "keep"}).status_code == 200

    response = client.post("/groups/1/action", json={"action": "apply_recommended"})

    assert response.status_code == 200
    detail = response.json()
    marks_by_id = {image["id"]: image["mark"] for image in detail["images"]}
    assert marks_by_id == {1: "delete", 2: "keep", 3: "keep", 4: "delete"}
    assert detail["group"]["completed"] is True
    assert detail["group"]["selection_state"] == "mixed"


def test_keep_all_marks_group_resolved_and_processed(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _seed_sort_group(data_dir, keep_image_id=1)
    client = _client(data_dir)

    response = client.post("/groups/1/action", json={"action": "keep_all"})

    assert response.status_code == 200
    manifest = Manifest(data_dir / "manifest.db")
    try:
        row = manifest.conn.execute("SELECT keep_all, resolved_at FROM groups WHERE group_id = 1").fetchone()
        assert row["keep_all"] == 1
        assert row["resolved_at"] is not None
    finally:
        manifest.close()

    assert client.get("/groups", params={"status": "unresolved"}).json()["items"] == []
    assert [group["id"] for group in client.get("/groups", params={"status": "processed"}).json()["items"]] == [1]


def test_list_groups_include_details_returns_bulk_group_details(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _seed_sort_group(data_dir, keep_image_id=1)
    client = _client(data_dir)

    listed = client.get("/groups")
    detailed = client.get("/groups", params={"include": "details"})

    assert listed.status_code == 200
    assert "images" not in listed.json()["items"][0]
    assert detailed.status_code == 200
    payload = detailed.json()
    assert payload["total_estimate"] == 1
    assert payload["items"][0]["group"]["id"] == 1
    assert [image["id"] for image in payload["items"][0]["images"]] == [1, 4, 2, 3]
    assert payload["items"][0]["images"][0]["recommended_keep"] is True


def test_list_groups_include_details_honors_processed_status_and_roots(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _seed_sort_group(data_dir, keep_image_id=1)
    client = _client(data_dir)

    assert client.post("/groups/1/action", json={"action": "keep_all"}).status_code == 200
    unresolved = client.get("/groups", params={"include": "details", "status": "unresolved", "roots": "C:\\Photos"})
    processed = client.get("/groups", params={"include": "details", "status": "processed", "roots": "C:\\Photos"})

    assert unresolved.status_code == 200
    assert unresolved.json()["items"] == []
    assert processed.status_code == 200
    payload = processed.json()
    assert [item["group"]["id"] for item in payload["items"]] == [1]
    assert payload["items"][0]["group"]["member_count"] == 4
    assert len(payload["items"][0]["images"]) == 4


def test_group_snapshot_prunes_stale_completion_state(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _seed_sort_group(data_dir, keep_image_id=1)
    api_module._save_group_completions(data_dir / "cache", {1, 999})
    manifest = Manifest(data_dir / "manifest.db")
    try:
        api_module._write_group_snapshot(data_dir / "cache", manifest, [])
    finally:
        manifest.close()

    assert api_module._load_group_completions(data_dir / "cache") == {1}


def test_mismatched_group_snapshot_is_not_loaded(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    cache_dir = data_dir / "cache"
    cache_dir.mkdir(parents=True)
    snapshot_path = api_module._snapshot_path(cache_dir, ["C:\\Current"])
    snapshot_path.write_text(
        json.dumps(
            {
                "version": 1,
                "generated_at": utc_now(),
                "roots": ["D:\\Deleted"],
                "items": [{"group": {"id": 999}, "images": []}],
            }
        ),
        encoding="utf-8",
    )

    client = _client(data_dir)
    response = client.get("/groups/snapshot", params={"roots": "C:\\Current"})

    assert response.status_code == 404
    assert not snapshot_path.exists()


def test_group_detail_orders_recommended_farthest_then_similarity_desc(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _seed_sort_group(data_dir, keep_image_id=1)
    client = _client(data_dir)

    response = client.get("/groups/1")

    assert response.status_code == 200
    assert [image["id"] for image in response.json()["images"]] == [1, 4, 2, 3]


def test_group_detail_keeps_existing_order_without_recommendation(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _seed_sort_group(data_dir, keep_image_id=None)
    client = _client(data_dir)

    response = client.get("/groups/1")

    assert response.status_code == 200
    assert [image["id"] for image in response.json()["images"]] == [1, 2, 3, 4]


def test_scan_reports_collecting_then_scanning_phase(tmp_path: Path, monkeypatch) -> None:
    images = tmp_path / "images"
    images.mkdir()
    image_path = images / "phase.jpg"
    image = ImageFile(
        path=image_path,
        size_bytes=123,
        mtime=1.0,
        taken_at=None,
        width=10,
        height=10,
        format="JPEG",
    )
    collecting_reported = threading.Event()
    release_collection = threading.Event()
    hashing_started = threading.Event()
    release_hashing = threading.Event()

    def fake_scan_folder(root: Path, progress_cb=None) -> list[ImageFile]:
        assert root == images
        assert progress_cb is not None
        progress_cb(500)
        collecting_reported.set()
        assert release_collection.wait(timeout=2)
        return [image]

    def fake_fingerprint(path: Path):
        assert path == image_path
        hashing_started.set()
        assert release_hashing.wait(timeout=2)
        return type("Fingerprint", (), {"phash": "a" * 16, "dhash": "b" * 16, "histogram": [0.1, 0.2]})()

    monkeypatch.setattr(api_module, "scan_folder", fake_scan_folder)
    monkeypatch.setattr(api_module, "fingerprint", fake_fingerprint)
    monkeypatch.setattr(api_module, "quality_score", lambda **_: (88.0, 10.0))
    monkeypatch.setattr(api_module, "make_thumbnail", lambda *_: tmp_path / "thumb.jpg")
    monkeypatch.setattr(api_module, "group_images", lambda *_args, **_kwargs: [])

    client = _client(tmp_path / "data")
    started = client.post("/scan", json={"roots": [str(images)], "threshold": 88})
    assert started.status_code == 202
    scan_id = started.json()["scan_id"]

    assert collecting_reported.wait(timeout=2)
    collecting = client.get(f"/scan/{scan_id}").json()
    assert collecting["status"] == "running"
    assert collecting["phase"] == "collecting"
    assert collecting["done"] == 500
    assert collecting["total"] == 0

    release_collection.set()
    assert hashing_started.wait(timeout=2)
    scanning = client.get(f"/scan/{scan_id}").json()
    assert scanning["status"] == "running"
    assert scanning["phase"] == "scanning"
    assert scanning["done"] == 0
    assert scanning["total"] == 1

    release_hashing.set()
    done = _wait_scan(client, scan_id)
    assert done["status"] == "done"


def test_scan_dedups_overlapping_roots_before_processing(tmp_path: Path, monkeypatch) -> None:
    parent = tmp_path / "photos"
    child = parent / "child"
    child.mkdir(parents=True)
    image_path = child / "same.jpg"
    image = ImageFile(
        path=image_path,
        size_bytes=123,
        mtime=1.0,
        taken_at=None,
        width=10,
        height=10,
        format="JPEG",
    )
    processed: list[Path] = []

    def fake_scan_folder(root: Path, progress_cb=None) -> list[ImageFile]:
        assert root in {parent, child}
        if progress_cb:
            progress_cb(1)
        return [image]

    def fake_fingerprint(path: Path):
        processed.append(path)
        return type("Fingerprint", (), {"phash": "a" * 16, "dhash": "b" * 16, "histogram": [0.1, 0.2]})()

    monkeypatch.setattr(api_module, "scan_folder", fake_scan_folder)
    monkeypatch.setattr(api_module, "fingerprint", fake_fingerprint)
    monkeypatch.setattr(api_module, "quality_score", lambda **_: (88.0, 10.0))
    monkeypatch.setattr(api_module, "make_thumbnail", lambda *_: tmp_path / "thumb.jpg")
    monkeypatch.setattr(api_module, "group_images", lambda *_args, **_kwargs: [])

    db_path = tmp_path / "data" / "manifest.db"
    Manifest(db_path).close()
    job = api_module.Job(id="scan-test", kind="scan")
    api_module._run_scan_job(job, db_path, tmp_path / "thumbs", tmp_path / "data" / "cache", [parent, child], 90)

    assert job.status == "done"
    assert processed == [image_path]
    assert job.summary is not None
    assert job.summary["images"] == 1
    assert "dedup skipped: 1" in str(job.summary["log"])


def test_scan_supersedes_running_scan_job(tmp_path: Path, monkeypatch) -> None:
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_root.mkdir()
    second_root.mkdir()
    first_collecting = threading.Event()
    release_first = threading.Event()

    def fake_scan_folder(root: Path, progress_cb=None) -> list[ImageFile]:
        if root == first_root:
            first_collecting.set()
            assert release_first.wait(timeout=2)
        if progress_cb:
            progress_cb(0)
        return []

    monkeypatch.setattr(api_module, "scan_folder", fake_scan_folder)

    client = _client(tmp_path / "data")
    first = client.post("/scan", json={"roots": [str(first_root)], "threshold": 88})
    assert first.status_code == 202
    first_scan_id = first.json()["scan_id"]
    assert first_collecting.wait(timeout=2)

    second = client.post("/scan", json={"roots": [str(second_root)], "threshold": 88})
    assert second.status_code == 202
    second_scan_id = second.json()["scan_id"]

    old_status = client.get(f"/scan/{first_scan_id}").json()
    assert old_status["status"] == "cancelled"
    assert second_scan_id != first_scan_id

    release_first.set()
    assert _wait_scan(client, second_scan_id)["status"] == "done"


def test_scan_supersedes_cancel_requested_scan_job(tmp_path: Path, monkeypatch) -> None:
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_root.mkdir()
    second_root.mkdir()
    image_path = first_root / "blocked.jpg"
    image = ImageFile(
        path=image_path,
        size_bytes=123,
        mtime=1.0,
        taken_at=None,
        width=10,
        height=10,
        format="JPEG",
    )
    hashing_started = threading.Event()
    release_hashing = threading.Event()

    def fake_scan_folder(root: Path, progress_cb=None) -> list[ImageFile]:
        if progress_cb:
            progress_cb(1 if root == first_root else 0)
        return [image] if root == first_root else []

    def fake_fingerprint(path: Path):
        assert path == image_path
        hashing_started.set()
        assert release_hashing.wait(timeout=2)
        return type("Fingerprint", (), {"phash": "a" * 16, "dhash": "b" * 16, "histogram": [0.1, 0.2]})()

    monkeypatch.setattr(api_module, "scan_folder", fake_scan_folder)
    monkeypatch.setattr(api_module, "fingerprint", fake_fingerprint)
    monkeypatch.setattr(api_module, "quality_score", lambda **_: (88.0, 10.0))
    monkeypatch.setattr(api_module, "make_thumbnail", lambda *_: tmp_path / "thumb.jpg")
    monkeypatch.setattr(api_module, "group_images", lambda *_args, **_kwargs: [])

    client = _client(tmp_path / "data")
    first = client.post("/scan", json={"roots": [str(first_root)], "threshold": 88})
    assert first.status_code == 202
    first_scan_id = first.json()["scan_id"]
    assert hashing_started.wait(timeout=2)

    cancelled = client.post(f"/scan/{first_scan_id}/cancel")
    assert cancelled.status_code == 202
    assert client.get(f"/scan/{first_scan_id}").json()["status"] == "cancel_requested"

    second = client.post("/scan", json={"roots": [str(second_root)], "threshold": 88})
    assert second.status_code == 202
    assert client.get(f"/scan/{first_scan_id}").json()["status"] == "cancelled"

    release_hashing.set()
    assert _wait_scan(client, second.json()["scan_id"])["status"] == "done"


def test_scan_cancel_before_group_persistence_writes_no_groups(tmp_path: Path, monkeypatch) -> None:
    images = tmp_path / "images"
    images.mkdir()
    image_files = [
        ImageFile(
            path=images / f"{name}.jpg",
            size_bytes=100,
            mtime=1.0,
            taken_at=None,
            width=10,
            height=10,
            format="JPEG",
        )
        for name in ("a", "b")
    ]

    def fake_scan_folder(root: Path, progress_cb=None) -> list[ImageFile]:
        if progress_cb:
            progress_cb(len(image_files))
        return image_files

    def fake_fingerprint(path: Path):
        return type("Fingerprint", (), {"phash": "a" * 16, "dhash": "b" * 16, "histogram": [0.1, 0.2]})()

    def fake_group_images(*_args, **_kwargs):
        job.cancel_requested = True
        return [[1, 2]]

    job = api_module.Job(id="scan-cancel-before-groups", kind="scan")
    monkeypatch.setattr(api_module, "scan_folder", fake_scan_folder)
    monkeypatch.setattr(api_module, "fingerprint", fake_fingerprint)
    monkeypatch.setattr(api_module, "quality_score", lambda **_: (88.0, 10.0))
    monkeypatch.setattr(api_module, "make_thumbnail", lambda *_: tmp_path / "thumb.jpg")
    monkeypatch.setattr(api_module, "group_images", fake_group_images)

    db_path = tmp_path / "data" / "manifest.db"
    Manifest(db_path).close()
    api_module._run_scan_job(job, db_path, tmp_path / "thumbs", tmp_path / "data" / "cache", [images], 90)

    assert job.status == "cancelled"
    manifest = Manifest(tmp_path / "data" / "manifest.db")
    try:
        assert manifest.conn.execute("SELECT COUNT(*) FROM groups").fetchone()[0] == 0
    finally:
        manifest.close()


def test_list_groups_hides_singleton_groups(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.executemany(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (?, ?, ?, 100, 90, ?)
            """,
            [
                (1, 1, 1, now),
                (2, 2, 2, now),
            ],
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark)
            VALUES (?, ?, 100, 1.0, 10, 10, 'jpg', 80, ?, 'none')
            """,
            [
                (1, "C:\\A\\singleton.jpg", 1),
                (2, "C:\\A\\pair-a.jpg", 2),
                (3, "C:\\A\\pair-b.jpg", 2),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    client = _client(data_dir)

    response = client.get("/groups", params={"min_size": "1"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["total_estimate"] == 1
    assert [item["id"] for item in payload["items"]] == [2]


def test_list_groups_filters_by_roots_after_matching_and_before_pagination(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.executemany(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (?, 2, ?, ?, 90, ?)
            """,
            [
                (1, 1, 300, now),
                (2, 3, 200, now),
                (3, 5, 100, now),
            ],
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark)
            VALUES (?, ?, 100, 1.0, 10, 10, 'jpg', 80, ?, 'none')
            """,
            [
                (1, "C:\\A\\one.jpg", 1),
                (2, "C:\\A\\nested\\two.jpg", 1),
                (3, "C:\\B\\one.jpg", 2),
                (4, "C:\\B\\two.jpg", 2),
                (5, "C:\\A2\\one.jpg", 3),
                (6, "C:\\A2\\two.jpg", 3),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    client = _client(data_dir)

    unfiltered = client.get("/groups?limit=1")
    assert unfiltered.status_code == 200
    assert unfiltered.json()["total_estimate"] == 3

    filtered = client.get("/groups", params=[("roots", "C:\\A"), ("limit", "1")])
    assert filtered.status_code == 200
    filtered_payload = filtered.json()
    assert filtered_payload["total_estimate"] == 1
    assert [item["id"] for item in filtered_payload["items"]] == [1]
    assert filtered_payload["next_cursor"] is None

    lower_case = client.get("/groups", params={"roots": "c:\\a"})
    assert lower_case.status_code == 200
    assert [item["id"] for item in lower_case.json()["items"]] == [1]


def test_list_groups_requires_two_images_under_selected_roots(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.executemany(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (?, ?, ?, 100, 90, ?)
            """,
            [
                (1, 2, 1, now),
                (2, 3, 3, now),
            ],
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark)
            VALUES (?, ?, 100, 1.0, 10, 10, 'jpg', 80, ?, 'none')
            """,
            [
                (1, "C:\\A\\one.jpg", 1),
                (2, "C:\\B\\one.jpg", 1),
                (3, "C:\\A\\two.jpg", 2),
                (4, "C:\\A\\three.jpg", 2),
                (5, "C:\\B\\two.jpg", 2),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    client = _client(data_dir)

    response = client.get("/groups", params={"roots": "C:\\A"})
    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload["items"]] == [2]
    assert payload["items"][0]["member_count"] == 2
    assert payload["total_estimate"] == 1


def test_list_groups_after_root_removal_returns_current_root_only(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.executemany(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (?, 2, ?, 100, 90, ?)
            """,
            [
                (1, 1, now),
                (2, 3, now),
            ],
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark)
            VALUES (?, ?, 100, 1.0, 10, 10, 'jpg', 80, ?, 'none')
            """,
            [
                (1, "C:\\Removed\\one.jpg", 1),
                (2, "C:\\Removed\\two.jpg", 1),
                (3, "D:\\Current\\one.jpg", 2),
                (4, "D:\\Current\\two.jpg", 2),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    client = _client(data_dir)
    response = client.get("/groups", params={"roots": "D:\\Current"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_estimate"] == 1
    assert [item["id"] for item in payload["items"]] == [2]
    detail = client.get("/groups/2", params={"roots": "D:\\Current"}).json()
    assert [image["path"] for image in detail["images"]] == ["D:\\Current\\one.jpg", "D:\\Current\\two.jpg"]


def test_group_detail_filters_images_by_roots(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.execute(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (1, 3, 1, 100, 90, ?)
            """,
            (now,),
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark)
            VALUES (?, ?, 100, 1.0, 10, 10, 'jpg', 80, 1, 'none')
            """,
            [
                (1, "C:\\A\\one.jpg"),
                (2, "C:\\A\\two.jpg"),
                (3, "C:\\B\\one.jpg"),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    client = _client(data_dir)

    scoped = client.get("/groups/1", params={"roots": "C:\\A"})
    assert scoped.status_code == 200
    assert [image["path"] for image in scoped.json()["images"]] == ["C:\\A\\one.jpg", "C:\\A\\two.jpg"]
    assert scoped.json()["group"]["member_count"] == 2

    unscoped = client.get("/groups/1")
    assert unscoped.status_code == 200
    assert [image["path"] for image in unscoped.json()["images"]] == ["C:\\A\\one.jpg", "C:\\A\\two.jpg", "C:\\B\\one.jpg"]


def test_scan_preserves_out_of_scope_manifest_results(tmp_path: Path) -> None:
    images = tmp_path / "A"
    images.mkdir()
    Image.new("RGB", (16, 16), "#123456").save(images / "scan.jpg")
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.execute(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (1, 2, 1, 100, 90, ?)
            """,
            (now,),
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark, resolved_at)
            VALUES (?, ?, 100, 1.0, 10, 10, 'jpg', 80, 1, 'none', ?)
            """,
            [
                (1, str(tmp_path / "B" / "unresolved.jpg"), None),
                (2, str(tmp_path / "B" / "resolved.jpg"), now),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    client = _client(data_dir)
    started = client.post("/scan", json={"roots": [str(images)], "threshold": 88})
    assert started.status_code == 202
    status = _wait_scan(client, started.json()["scan_id"])
    assert status["status"] == "done"
    assert status["summary"]["log"] == "previous results preserved until scan completion; scoped groups replaced=0"

    manifest = Manifest(data_dir / "manifest.db")
    try:
        unresolved = manifest.conn.execute("SELECT id FROM images WHERE id = 1").fetchone()
        resolved = manifest.conn.execute("SELECT id, resolved_at FROM images WHERE id = 2").fetchone()
        stale_group = manifest.conn.execute("SELECT group_id FROM groups WHERE group_id = 1").fetchone()
        assert unresolved is not None
        assert resolved is not None
        assert resolved["resolved_at"] == now
        assert stale_group is not None
    finally:
        manifest.close()


def test_patch_image_mark_updates_group_selection_state(tmp_path: Path) -> None:
    images = tmp_path / "images"
    images.mkdir()
    _write_sample_images(images)
    client = _client(tmp_path / "data")

    scan_id = client.post("/scan", json={"roots": [str(images)], "threshold": 88}).json()["scan_id"]
    _wait_scan(client, scan_id)
    group = client.get("/groups").json()["items"][0]
    detail = client.get(f"/groups/{group['id']}").json()
    target = next(image for image in detail["images"] if image["recommended_keep"])

    response = client.patch(f"/images/{target['id']}", json={"mark": "delete"})
    assert response.status_code == 200
    updated = client.get(f"/groups/{group['id']}").json()
    assert updated["group"]["selection_state"] in {"delete_all", "mixed"}
    assert updated["group"]["selection_state"] != "recommended_applied"


def test_apply_trash_marks_deleted_images_resolved_and_moves_group_to_processed(tmp_path: Path) -> None:
    data_dir, delete_file = _seed_apply_group(tmp_path)
    client = _client(data_dir)

    started = client.post("/apply", json={"mode": "trash"})
    assert started.status_code == 202
    cleanup = _wait_cleanup(client, started.json()["job_id"])
    assert cleanup["status"] == "done"
    assert cleanup["summary"] == {"deleted": 1, "failed": 0, "already_missing": 0}

    manifest = Manifest(data_dir / "manifest.db")
    try:
        deleted = manifest.conn.execute(
            "SELECT is_quarantined, resolved_at FROM images WHERE id = 2"
        ).fetchone()
        kept = manifest.conn.execute(
            "SELECT is_quarantined, resolved_at FROM images WHERE id = 1"
        ).fetchone()
        assert deleted["is_quarantined"] == 1
        assert deleted["resolved_at"] is not None
        assert kept["is_quarantined"] == 0
        assert kept["resolved_at"] is None
        group = manifest.conn.execute("SELECT resolved_at FROM groups WHERE group_id = 1").fetchone()
        assert group["resolved_at"] is not None
        assert not delete_file.exists()
    finally:
        manifest.close()

    unresolved = client.get("/groups", params={"status": "unresolved"})
    processed = client.get("/groups", params={"status": "processed"})
    assert unresolved.status_code == 200
    assert processed.status_code == 200
    assert unresolved.json()["items"] == []
    assert [group["id"] for group in processed.json()["items"]] == [1]


def test_apply_permanent_marks_deleted_images_resolved_and_moves_group_to_processed(tmp_path: Path) -> None:
    data_dir, delete_file = _seed_apply_group(tmp_path)
    client = _client(data_dir)

    started = client.post("/apply", json={"mode": "permanent"})
    assert started.status_code == 202
    cleanup = _wait_cleanup(client, started.json()["job_id"])
    assert cleanup["status"] == "done"
    assert cleanup["summary"] == {"deleted": 1, "failed": 0, "already_missing": 0}

    manifest = Manifest(data_dir / "manifest.db")
    try:
        deleted = manifest.conn.execute(
            "SELECT is_quarantined, resolved_at FROM images WHERE id = 2"
        ).fetchone()
        assert deleted["is_quarantined"] == 1
        assert deleted["resolved_at"] is not None
        group = manifest.conn.execute("SELECT resolved_at FROM groups WHERE group_id = 1").fetchone()
        assert group["resolved_at"] is not None
        assert not delete_file.exists()
    finally:
        manifest.close()

    unresolved = client.get("/groups", params={"status": "unresolved"})
    processed = client.get("/groups", params={"status": "processed"})
    assert unresolved.status_code == 200
    assert processed.status_code == 200
    assert unresolved.json()["items"] == []
    assert [group["id"] for group in processed.json()["items"]] == [1]


@pytest.mark.parametrize("mode", ["trash", "permanent"])
def test_apply_marks_already_missing_delete_target_resolved(
    tmp_path: Path,
    mode: str,
) -> None:
    data_dir, delete_file = _seed_apply_group(tmp_path)
    delete_file.unlink()
    client = _client(data_dir)

    started = client.post("/apply", json={"mode": mode})
    assert started.status_code == 202
    cleanup = _wait_cleanup(client, started.json()["job_id"])
    assert cleanup["status"] == "done"
    assert cleanup["summary"] == {"deleted": 1, "failed": 0, "already_missing": 1}

    manifest = Manifest(data_dir / "manifest.db")
    try:
        deleted = manifest.conn.execute(
            "SELECT is_quarantined, resolved_at FROM images WHERE id = 2"
        ).fetchone()
        assert deleted["is_quarantined"] == 1
        assert deleted["resolved_at"] is not None
        group = manifest.conn.execute("SELECT resolved_at FROM groups WHERE group_id = 1").fetchone()
        assert group["resolved_at"] is not None
    finally:
        manifest.close()


def test_apply_group_ids_filters_cleanup_targets(tmp_path: Path) -> None:
    data_dir, files = _seed_two_apply_groups(tmp_path)
    client = _client(data_dir)

    started = client.post("/apply", json={"mode": "trash", "group_ids": [1]})
    assert started.status_code == 202
    assert started.json()["targets"] == 1
    cleanup = _wait_cleanup(client, started.json()["job_id"])
    assert cleanup["status"] == "done"
    assert cleanup["summary"] == {"deleted": 1, "failed": 0, "already_missing": 0}

    manifest = Manifest(data_dir / "manifest.db")
    try:
        group_1_delete = manifest.conn.execute("SELECT is_quarantined FROM images WHERE id = 2").fetchone()
        group_2_delete = manifest.conn.execute("SELECT is_quarantined FROM images WHERE id = 4").fetchone()
        assert group_1_delete["is_quarantined"] == 1
        assert group_2_delete["is_quarantined"] == 0
        assert not files[2].exists()
        assert files[4].exists()
    finally:
        manifest.close()


def test_apply_without_group_ids_keeps_existing_all_group_behavior(tmp_path: Path) -> None:
    data_dir, files = _seed_two_apply_groups(tmp_path)
    client = _client(data_dir)

    started = client.post("/apply", json={"mode": "trash"})
    assert started.status_code == 202
    assert started.json()["targets"] == 2
    cleanup = _wait_cleanup(client, started.json()["job_id"])
    assert cleanup["status"] == "done"
    assert cleanup["summary"] == {"deleted": 2, "failed": 0, "already_missing": 0}

    assert not files[2].exists()
    assert not files[4].exists()


def test_manifest_backfills_legacy_quarantined_resolved_at_and_excludes_unresolved(
    tmp_path: Path,
    caplog,
) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.execute(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (1, 2, 1, 100, 90, ?)
            """,
            (now,),
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(
                id, path, size_bytes, mtime, width, height, format, quality_score,
                group_id, mark, is_keep, is_quarantined, resolved_at
            )
            VALUES (?, ?, 100, 1.0, 16, 16, 'jpg', 80, 1, ?, ?, ?, ?)
            """,
            [
                (1, str(tmp_path / "keep.jpg"), "keep", 1, 0, None),
                (2, str(tmp_path / "delete.jpg"), "delete", 0, 1, None),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    caplog.set_level("INFO", logger="photodedup.manifest")
    reopened = Manifest(data_dir / "manifest.db")
    try:
        legacy = reopened.conn.execute(
            "SELECT resolved_at FROM images WHERE id = 2"
        ).fetchone()
        assert legacy["resolved_at"] is not None
        assert "backfill resolved_at: 1 rows" in caplog.text
        assert reopened.backfill_quarantined_resolved_at() == 0
    finally:
        reopened.close()

    client = _client(data_dir)
    unresolved = client.get("/groups", params={"status": "unresolved"})
    processed = client.get("/groups", params={"status": "processed"})
    assert unresolved.status_code == 200
    assert processed.status_code == 200
    assert unresolved.json()["items"] == []
    assert [group["id"] for group in processed.json()["items"]] == [1]


def test_settings_roundtrip_and_scan_uses_stored_threshold(tmp_path: Path) -> None:
    images = tmp_path / "images"
    images.mkdir()
    _write_sample_images(images)
    data_dir = tmp_path / "data"
    client = _client(data_dir)

    put_response = client.put("/settings", json={"threshold": 77})
    assert put_response.status_code == 200
    assert put_response.json()["threshold"] == 77
    assert put_response.json()["scan_folders"] == []
    assert client.get("/settings").json()["threshold"] == 77

    started = client.post("/scan", json={"roots": [str(images)]})
    assert started.status_code == 202
    status = _wait_scan(client, started.json()["scan_id"])
    assert status["status"] == "done"

    manifest = Manifest(data_dir / "manifest.db")
    try:
        row = manifest.conn.execute("SELECT value FROM scan_meta WHERE key = 'threshold'").fetchone()
        assert row is not None
        assert row["value"] == "77"
    finally:
        manifest.close()
    assert client.get("/settings").json()["scan_folders"] == [str(images)]


def test_settings_save_updates_persisted_scan_folders(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    client = _client(data_dir)
    old_root = str(tmp_path / "old")
    new_root = str(tmp_path / "도아")

    first = client.put("/settings", json={"threshold": 90, "scan_folders": [old_root]})
    second = client.put("/settings", json={"threshold": 90, "scan_folders": [new_root]})

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["scan_folders"] == [new_root]
    assert client.get("/settings").json()["scan_folders"] == [new_root]


def test_restart_restores_last_saved_scan_folders(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    root = str(tmp_path / "C" / "Users" / "lisyo" / "OneDrive" / "Pictures" / "도아")
    client = _client(data_dir)

    saved = client.put("/settings", json={"threshold": 90, "scan_folders": [root]})
    assert saved.status_code == 200

    restarted_client = _client(data_dir)
    restored = restarted_client.get("/settings")

    assert restored.status_code == 200
    assert restored.json()["scan_folders"] == [root]


def test_settings_missing_include_online_only_defaults_false(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "settings.json").write_text(
        json.dumps({
            "threshold": 88,
            "recursive": True,
            "extensions": ["jpg", "heic"],
            "cleanup_mode": "trash",
            "scan_folders": [],
        }),
        encoding="utf-8",
    )

    response = _client(data_dir).get("/settings")

    assert response.status_code == 200
    assert response.json()["include_online_only"] is False


def test_scan_passes_include_online_only_setting_to_scanner(tmp_path: Path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    root = tmp_path / "images"
    root.mkdir()
    captured: list[bool] = []

    def fake_scan_folder_with_stats(path: Path, progress_cb=None, cancel_cb=None, include_online_only: bool = False) -> ScanFolderResult:
        captured.append(include_online_only)
        if progress_cb:
            progress_cb(0)
        return ScanFolderResult(files=[], stats=ScanStats())

    monkeypatch.setattr(api_module, "scan_folder_with_stats", fake_scan_folder_with_stats)
    client = _client(data_dir)
    saved = client.put("/settings", json={"threshold": 90, "scan_folders": [str(root)], "include_online_only": True})
    assert saved.status_code == 200

    started = client.post("/scan", json={"roots": [str(root)]})
    assert started.status_code == 202
    assert _wait_scan(client, started.json()["scan_id"])["status"] == "done"

    assert captured == [True]


def test_scan_after_folder_change_targets_new_root_only_and_preserves_old_data(
    tmp_path: Path,
    monkeypatch,
) -> None:
    data_dir = tmp_path / "data"
    old_root = tmp_path / "old"
    new_root = tmp_path / "도아"
    old_root.mkdir()
    new_root.mkdir()
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.execute(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (1, 2, 1, 100, 90, ?)
            """,
            (now,),
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark)
            VALUES (?, ?, 100, 1.0, 10, 10, 'jpg', 80, 1, 'none')
            """,
            [
                (1, str(old_root / "one.jpg")),
                (2, str(old_root / "two.jpg")),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    scanned_roots: list[Path] = []

    def fake_scan_folder(root: Path, progress_cb=None) -> list[ImageFile]:
        scanned_roots.append(root)
        if progress_cb:
            progress_cb(0)
        return []

    monkeypatch.setattr(api_module, "scan_folder", fake_scan_folder)
    client = _client(data_dir)
    saved = client.put("/settings", json={"threshold": 90, "scan_folders": [str(new_root)]})
    assert saved.status_code == 200

    started = client.post("/scan", json={"roots": [str(new_root)]})
    assert started.status_code == 202
    assert _wait_scan(client, started.json()["scan_id"])["status"] == "done"

    assert scanned_roots == [new_root]
    manifest = Manifest(data_dir / "manifest.db")
    try:
        assert manifest.conn.execute("SELECT COUNT(*) FROM groups WHERE group_id = 1").fetchone()[0] == 1
        assert manifest.conn.execute("SELECT COUNT(*) FROM images WHERE path LIKE ?", (f"{old_root}%",)).fetchone()[0] == 2
    finally:
        manifest.close()


def test_unicode_scan_folder_roundtrips_through_settings_file(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    unicode_root = "C:\\Users\\lisyo\\OneDrive\\Pictures\\도아"
    client = _client(data_dir)

    response = client.put(
        "/settings",
        json={
            "threshold": 90,
            "scan_folders": [unicode_root],
            "scan_folders_updated_at": "2026-07-14T00:00:00Z",
        },
    )
    reloaded = _client(data_dir).get("/settings")

    assert response.status_code == 200
    assert response.json()["scan_folders"] == [unicode_root]
    assert reloaded.json()["scan_folders"] == [unicode_root]
    settings_text = (data_dir / "settings.json").read_text(encoding="utf-8")
    assert "도아" in settings_text
    assert json.loads(settings_text)["scan_folders"] == [unicode_root]


def test_apply_records_evaluated_group_signature(tmp_path: Path) -> None:
    data_dir, _delete_file = _seed_apply_group_with_hashes(tmp_path)
    client = _client(data_dir)

    started = client.post("/apply", json={"mode": "trash"})
    assert started.status_code == 202
    cleanup = _wait_cleanup(client, started.json()["job_id"])
    assert cleanup["status"] == "done"

    manifest = Manifest(data_dir / "manifest.db")
    try:
        rows = manifest.conn.execute("SELECT signature, member_count, root_hint FROM evaluated_groups").fetchall()
        assert len(rows) == 1
        assert rows[0]["member_count"] == 2
        assert rows[0]["root_hint"] == str((tmp_path / "images").resolve())
    finally:
        manifest.close()


def test_regroup_persists_previously_evaluated_same_members_as_resolved(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        _insert_hashed_images(manifest, tmp_path, [1, 2], group_id=1)
        manifest.conn.execute(
            "INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at) VALUES (1, 2, 1, 100, 90, ?)",
            (utc_now(),),
        )
        assert manifest.record_evaluated_group(1) is not None
        manifest.conn.commit()

        summary = manifest.regroup(90)

        assert summary["duplicate_groups"] == 1
        group = manifest.conn.execute("SELECT group_id, resolved_at FROM groups").fetchone()
        assert group["resolved_at"] is not None
    finally:
        manifest.close()

    client = _client(data_dir)
    processed = client.get("/groups", params={"status": "processed"})
    unresolved = client.get("/groups", params={"status": "unresolved"})
    all_groups = client.get("/groups", params={"status": "all"})
    assert processed.status_code == 200
    assert unresolved.status_code == 200
    assert all_groups.status_code == 200
    assert [group["id"] for group in processed.json()["items"]] == [group["group_id"]]
    assert unresolved.json()["items"] == []
    assert [group["id"] for group in all_groups.json()["items"]] == [group["group_id"]]


def test_api_scan_persists_evaluated_groups_as_resolved_rows(tmp_path: Path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    db_path = data_dir / "manifest.db"
    manifest = Manifest(db_path)
    try:
        _insert_hashed_images(manifest, tmp_path, [1, 2], group_id=1)
        manifest.conn.execute(
            "INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at) VALUES (1, 2, 1, 100, 90, ?)",
            (utc_now(),),
        )
        assert manifest.record_evaluated_group(1) is not None
        manifest.conn.commit()
        image_rows = manifest.conn.execute("SELECT id, path, size_bytes FROM images ORDER BY id").fetchall()
    finally:
        manifest.close()

    image_files = [
        ImageFile(
            path=Path(row["path"]),
            size_bytes=int(row["size_bytes"]),
            mtime=1.0,
            taken_at=None,
            width=16,
            height=16,
            format="JPEG",
        )
        for row in image_rows
    ]
    monkeypatch.setattr(api_module, "scan_folder", lambda root, progress_cb=None: image_files)
    monkeypatch.setattr(api_module, "make_thumbnail", lambda *_: tmp_path / "thumb.jpg")
    monkeypatch.setattr(api_module, "group_images", lambda *_args, **_kwargs: [[1, 2]])

    job = api_module.Job(id="scan-evaluated", kind="scan")
    api_module._run_scan_job(job, db_path, tmp_path / "thumbs", data_dir / "cache", [tmp_path], 90)

    assert job.status == "done"
    client = _client(data_dir)
    processed = client.get("/groups", params={"status": "processed"})
    unresolved = client.get("/groups", params={"status": "unresolved"})
    assert processed.status_code == 200
    assert unresolved.status_code == 200
    assert len(processed.json()["items"]) == 1
    assert unresolved.json()["items"] == []


def test_regroup_reexposes_evaluated_group_when_new_member_changes_signature(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        _insert_hashed_images(manifest, tmp_path, [1, 2], group_id=1)
        manifest.conn.execute(
            "INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at) VALUES (1, 2, 1, 100, 90, ?)",
            (utc_now(),),
        )
        assert manifest.record_evaluated_group(1) is not None
        _insert_hashed_images(manifest, tmp_path, [3], group_id=None)
        manifest.conn.commit()

        summary = manifest.regroup(90)

        assert summary["duplicate_groups"] == 1
        group = manifest.conn.execute("SELECT member_count FROM groups").fetchone()
        assert group["member_count"] == 3
    finally:
        manifest.close()


def test_list_groups_hides_groups_with_fewer_than_two_active_unresolved_members(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.execute(
            "INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at) VALUES (1, 2, 1, 100, 90, ?)",
            (now,),
        )
        manifest.conn.execute(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark)
            VALUES (1, ?, 100, 1.0, 16, 16, 'jpg', 80, 1, 'none')
            """,
            (str(tmp_path / "only.jpg"),),
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    response = _client(data_dir).get("/groups")

    assert response.status_code == 200
    assert response.json()["items"] == []
    assert response.json()["total_estimate"] == 0


def test_startup_marks_residual_zero_byte_groups_without_deleting_rows(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.execute(
            "INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at) VALUES (1, 2, 1, 0, 90, ?)",
            (now,),
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark, is_keep)
            VALUES (?, ?, 0, 1.0, 16, 16, 'jpg', 80, 1, 'keep', 1)
            """,
            [(1, str(tmp_path / "keep-a.jpg")), (2, str(tmp_path / "keep-b.jpg"))],
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    reopened = Manifest(data_dir / "manifest.db")
    try:
        group = reopened.conn.execute("SELECT resolved_at FROM groups WHERE group_id = 1").fetchone()
        assert group["resolved_at"] is not None
        assert reopened.conn.execute("SELECT COUNT(*) FROM groups").fetchone()[0] == 1
        assert reopened.conn.execute("SELECT COUNT(*) FROM images").fetchone()[0] == 2
    finally:
        reopened.close()

    assert _client(data_dir).get("/groups").json()["items"] == []


def test_backfill_marks_zero_live_member_groups_resolved_idempotently(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.execute(
            "INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at) VALUES (1, 2, 1, 100, 90, ?)",
            (now,),
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark, is_quarantined, resolved_at)
            VALUES (?, ?, 100, 1.0, 16, 16, 'jpg', 80, 1, 'delete', ?, ?)
            """,
            [
                (1, str(tmp_path / "done-a.jpg"), 1, now),
                (2, str(tmp_path / "done-b.jpg"), 1, now),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()

    reopened = Manifest(data_dir / "manifest.db")
    try:
        group = reopened.conn.execute("SELECT resolved_at FROM groups WHERE group_id = 1").fetchone()
        assert group["resolved_at"] is not None
        first_resolved_at = group["resolved_at"]
        assert reopened.mark_residual_zero_byte_groups() == 0
        group_again = reopened.conn.execute("SELECT resolved_at FROM groups WHERE group_id = 1").fetchone()
        assert group_again["resolved_at"] == first_resolved_at
    finally:
        reopened.close()


def _seed_apply_group(tmp_path: Path) -> tuple[Path, Path]:
    images = tmp_path / "images"
    images.mkdir()
    keep_file = images / "keep.jpg"
    delete_file = images / "delete.jpg"
    Image.new("RGB", (16, 16), "#123456").save(keep_file)
    Image.new("RGB", (16, 16), "#654321").save(delete_file)
    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.execute(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (1, 2, 1, 100, 90, ?)
            """,
            (now,),
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark, is_keep)
            VALUES (?, ?, 100, 1.0, 16, 16, 'jpg', 80, 1, ?, ?)
            """,
            [
                (1, str(keep_file), "keep", 1),
                (2, str(delete_file), "delete", 0),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()
    return data_dir, delete_file


def _seed_apply_group_with_hashes(tmp_path: Path) -> tuple[Path, Path]:
    data_dir, delete_file = _seed_apply_group(tmp_path)
    manifest = Manifest(data_dir / "manifest.db")
    try:
        manifest.conn.executemany(
            "UPDATE images SET phash = ?, dhash = ? WHERE id = ?",
            [
                ("0000000000000000", "0000000000000000", 1),
                ("0000000000000001", "0000000000000001", 2),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()
    return data_dir, delete_file


def _insert_hashed_images(manifest: Manifest, tmp_path: Path, image_ids: list[int], group_id: int | None) -> None:
    for image_id in image_ids:
        image_path = tmp_path / f"image-{image_id}.jpg"
        Image.new("RGB", (16, 16), "#123456").save(image_path)
        manifest.conn.execute(
            """
            INSERT INTO images(
                id, path, size_bytes, mtime, width, height, format, quality_score,
                phash, dhash, group_id, mark
            )
            VALUES (?, ?, ?, 1.0, 16, 16, 'jpg', ?, '0000000000000000', '0000000000000000', ?, 'none')
            """,
            (image_id, str(image_path), image_path.stat().st_size, 90.0 - image_id, group_id),
        )
        manifest.conn.execute(
            "INSERT INTO image_histograms(image_id, histogram) VALUES (?, ?)",
            (image_id, "[1.0, 0.0, 0.0]"),
        )


def _seed_two_apply_groups(tmp_path: Path) -> tuple[Path, dict[int, Path]]:
    images = tmp_path / "images"
    images.mkdir()
    files = {
        1: images / "g1_keep.jpg",
        2: images / "g1_delete.jpg",
        3: images / "g2_keep.jpg",
        4: images / "g2_delete.jpg",
    }
    for image_id, path in files.items():
        Image.new("RGB", (16, 16), f"#{image_id}{image_id}{image_id}{image_id}{image_id}{image_id}").save(path)

    data_dir = tmp_path / "data"
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.executemany(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (?, 2, ?, 100, 90, ?)
            """,
            [(1, 1, now), (2, 3, now)],
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(id, path, size_bytes, mtime, width, height, format, quality_score, group_id, mark, is_keep)
            VALUES (?, ?, 100, 1.0, 16, 16, 'jpg', 80, ?, ?, ?)
            """,
            [
                (1, str(files[1]), 1, "keep", 1),
                (2, str(files[2]), 1, "delete", 0),
                (3, str(files[3]), 2, "keep", 1),
                (4, str(files[4]), 2, "delete", 0),
            ],
        )
        manifest.conn.commit()
    finally:
        manifest.close()
    return data_dir, files


def _seed_sort_group(data_dir: Path, keep_image_id: int | None) -> None:
    manifest = Manifest(data_dir / "manifest.db")
    try:
        now = utc_now()
        manifest.conn.execute(
            """
            INSERT INTO groups(group_id, member_count, keep_image_id, reclaimable_bytes, threshold, created_at)
            VALUES (1, 4, ?, 100, 90, ?)
            """,
            (keep_image_id, now),
        )
        manifest.conn.executemany(
            """
            INSERT INTO images(
                id, path, size_bytes, mtime, width, height, format, quality_score,
                phash, dhash, group_id, mark, is_keep
            )
            VALUES (?, ?, 100, 1.0, 16, 16, 'jpg', 80, ?, ?, 1, 'none', ?)
            """,
            [
                (1, "C:\\Photos\\recommended.jpg", "0000000000000000", "0000000000000000", 1 if keep_image_id == 1 else 0),
                (2, "C:\\Photos\\near.jpg", "0000000000000001", "0000000000000001", 0),
                (3, "C:\\Photos\\middle.jpg", "000000000000000f", "000000000000000f", 0),
                (4, "C:\\Photos\\far.jpg", "ffffffffffffffff", "ffffffffffffffff", 0),
            ],
        )
        manifest.conn.executemany(
            """
            INSERT INTO image_histograms(image_id, histogram)
            VALUES (?, ?)
            """,
            [(image_id, "[1.0, 0.0, 0.0]") for image_id in (1, 2, 3, 4)],
        )
        manifest.conn.commit()
    finally:
        manifest.close()


def _wait_scan(client: TestClient, scan_id: str) -> dict[str, object]:
    deadline = time.time() + 20
    while time.time() < deadline:
        response = client.get(f"/scan/{scan_id}")
        assert response.status_code == 200
        payload = response.json()
        if payload["status"] in {"done", "error", "cancelled"}:
            return payload
        time.sleep(0.05)
    raise AssertionError("scan did not finish")


def _wait_cleanup(client: TestClient, cleanup_id: str) -> dict[str, object]:
    deadline = time.time() + 20
    while time.time() < deadline:
        response = client.get(f"/cleanup/{cleanup_id}")
        assert response.status_code == 200
        payload = response.json()
        if payload["status"] in {"done", "error", "cancelled"}:
            return payload
        time.sleep(0.05)
    raise AssertionError("cleanup did not finish")
