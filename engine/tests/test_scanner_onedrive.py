from __future__ import annotations

from pathlib import Path
import stat

import pytest
from PIL import Image

from photodedup import scanner


class _FakeStat:
    st_mode = stat.S_IFREG | 0o644
    st_file_attributes = 0x1000
    st_size = 123
    st_mtime = 1.0


class _FakeDirReparseStat:
    st_mode = stat.S_IFDIR | 0o755
    st_file_attributes = 0x400
    st_size = 0
    st_mtime = 1.0


def test_scan_folder_skips_onedrive_offline_placeholder_without_opening(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    image_path = tmp_path / "cloud.jpg"
    image_path.write_bytes(b"not downloaded")
    original_stat = Path.stat

    def fake_stat(self: Path, *args: object, **kwargs: object):
        if self == image_path:
            return _FakeStat()
        return original_stat(self, *args, **kwargs)

    def fail_open(*args: object, **kwargs: object) -> None:
        raise AssertionError("placeholder file should not be opened")

    monkeypatch.setattr(Path, "stat", fake_stat)
    monkeypatch.setattr(scanner.Image, "open", fail_open)

    result = scanner.scan_folder_with_stats(tmp_path)

    assert result.files == []
    assert result.stats.cloud_placeholders == 1


def test_scan_folder_skips_cloud_placeholder_by_default_with_monkeypatched_detector(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "cloud.jpg"
    Image.new("RGB", (8, 8), "#123456").save(image_path)

    def fake_is_cloud_placeholder(_stat: object, path: Path | None = None) -> bool:
        return path == image_path

    def fail_open(*args: object, **kwargs: object) -> None:
        raise AssertionError("placeholder file should not be opened")

    monkeypatch.setattr(scanner, "_is_cloud_placeholder", fake_is_cloud_placeholder)
    monkeypatch.setattr(scanner.Image, "open", fail_open)

    result = scanner.scan_folder_with_stats(tmp_path, include_online_only=False)

    assert result.files == []
    assert result.stats.cloud_placeholders == 1


def test_scan_folder_includes_cloud_placeholder_when_requested(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "cloud.jpg"
    Image.new("RGB", (8, 8), "#123456").save(image_path)

    def fake_is_cloud_placeholder(_stat: object, path: Path | None = None) -> bool:
        return path == image_path

    monkeypatch.setattr(scanner, "_is_cloud_placeholder", fake_is_cloud_placeholder)

    result = scanner.scan_folder_with_stats(tmp_path, include_online_only=True)

    assert [image.path for image in result.files] == [image_path.resolve()]
    assert result.stats.cloud_placeholders == 0


def test_scan_folder_cancel_callback_stops_collection(tmp_path: Path) -> None:
    Image.new("RGB", (8, 8), "#123456").save(tmp_path / "a.jpg")

    class Cancelled(Exception):
        pass

    def cancel() -> None:
        raise Cancelled

    with pytest.raises(Cancelled):
        scanner.scan_folder_with_stats(tmp_path, cancel_cb=cancel)


def test_scan_folder_skips_reparse_directories(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reparse_dir = tmp_path / "onedrive-reparse"
    reparse_dir.mkdir()
    Image.new("RGB", (8, 8), "#123456").save(reparse_dir / "nested.jpg")
    original_stat = Path.stat

    def fake_stat(self: Path, *args: object, **kwargs: object):
        if self == reparse_dir:
            return _FakeDirReparseStat()
        return original_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", fake_stat)

    result = scanner.scan_folder_with_stats(tmp_path)

    assert result.files == []
    assert result.stats.reparse_dirs == 1
