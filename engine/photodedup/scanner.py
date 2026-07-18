from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import logging
import os
from pathlib import Path
import stat as _stat
import subprocess
from typing import Callable, Iterable

from PIL import Image

LOGGER = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".heic",
    ".heif",
    ".png",
    ".webp",
}
HEIC_EXTENSIONS = {".heic", ".heif"}
_RECALL_ON_DATA_ACCESS = 0x400000
_REPARSE_POINT = 0x400

_HEIF_REGISTERED: bool | None = None


@dataclass(frozen=True)
class ImageFile:
    path: Path
    size_bytes: int
    mtime: float
    taken_at: str | None
    width: int
    height: int
    format: str


@dataclass(frozen=True)
class ScanStats:
    images: int = 0
    cloud_placeholders: int = 0
    reparse_dirs: int = 0
    unreadable: int = 0


@dataclass(frozen=True)
class ScanFolderResult:
    files: list[ImageFile]
    stats: ScanStats


def register_heif() -> bool:
    global _HEIF_REGISTERED
    if _HEIF_REGISTERED is not None:
        return _HEIF_REGISTERED
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
        _HEIF_REGISTERED = True
    except Exception as exc:  # pragma: no cover - depends on host libheif setup
        LOGGER.warning("HEIC/HEIF support unavailable, skipping HEIC files: %s", exc)
        _HEIF_REGISTERED = False
    return _HEIF_REGISTERED


def iter_image_paths(root: Path) -> Iterable[Path]:
    result = scan_folder_with_stats(root)
    for image in result.files:
        yield image.path


def scan_folder(
    root: Path,
    progress_cb: Callable[..., None] | None = None,
    cancel_cb: Callable[[], None] | None = None,
    include_online_only: bool = False,
) -> list[ImageFile]:
    return scan_folder_with_stats(
        root,
        progress_cb=progress_cb,
        cancel_cb=cancel_cb,
        include_online_only=include_online_only,
    ).files


def scan_folder_with_stats(
    root: Path,
    progress_cb: Callable[..., None] | None = None,
    cancel_cb: Callable[[], None] | None = None,
    include_online_only: bool = False,
) -> ScanFolderResult:
    images: list[ImageFile] = []
    cloud_placeholder_count = 0
    reparse_dir_count = 0
    unreadable_count = 0
    heif_ok = None
    root = root.expanduser().resolve()

    for current_root, dirnames, filenames in os.walk(root, followlinks=False):
        if cancel_cb:
            cancel_cb()
        current_path = Path(current_root)
        windows_reparse_names = _windows_reparse_child_names(current_path)
        kept_dirs = []
        for dirname in sorted(dirnames):
            child = current_path / dirname
            try:
                child_stat = child.stat(follow_symlinks=False)
            except OSError:
                unreadable_count += 1
                continue
            if dirname in windows_reparse_names or _is_reparse_point(child, child_stat):
                reparse_dir_count += 1
                _emit_progress(progress_cb, len(images), child, cloud_placeholder_count, reparse_dir_count)
                continue
            kept_dirs.append(dirname)
        dirnames[:] = kept_dirs

        for filename in sorted(filenames):
            if cancel_cb:
                cancel_cb()
            path = current_path / filename
            _emit_progress(progress_cb, len(images), path, cloud_placeholder_count, reparse_dir_count)
            try:
                path_stat = path.stat(follow_symlinks=False)
            except OSError as exc:
                unreadable_count += 1
                LOGGER.warning("Skipping unreadable image candidate %s: %s", path, exc)
                continue
            if not _is_regular_file(path_stat):
                continue
            if not include_online_only and _is_cloud_placeholder(path_stat, path):
                cloud_placeholder_count += 1
                _emit_progress(progress_cb, len(images), path, cloud_placeholder_count, reparse_dir_count)
                continue
            suffix = path.suffix.lower()
            if suffix not in SUPPORTED_EXTENSIONS:
                continue
            if suffix in HEIC_EXTENSIONS and heif_ok is None:
                heif_ok = register_heif()
            if suffix in HEIC_EXTENSIONS and not heif_ok:
                continue
            try:
                with Image.open(path) as im:
                    width, height = im.size
                    fmt = (im.format or path.suffix.lstrip(".")).upper()
                    taken_at = _extract_taken_at_from_image(im, path_stat.st_mtime)
                images.append(
                    ImageFile(
                        path=path.resolve(),
                        size_bytes=path_stat.st_size,
                        mtime=path_stat.st_mtime,
                        taken_at=taken_at,
                        width=width,
                        height=height,
                        format=fmt,
                    )
                )
                if len(images) % 50 == 0:
                    _emit_progress(progress_cb, len(images), path, cloud_placeholder_count, reparse_dir_count)
            except Exception as exc:
                unreadable_count += 1
                LOGGER.warning("Skipping unreadable image %s: %s", path, exc)
    _emit_progress(progress_cb, len(images), root, cloud_placeholder_count, reparse_dir_count)
    if cloud_placeholder_count:
        LOGGER.info("Skipped %d OneDrive online-only placeholder images", cloud_placeholder_count)
    if reparse_dir_count:
        LOGGER.info("Skipped %d reparse point directories", reparse_dir_count)
    return ScanFolderResult(
        files=images,
        stats=ScanStats(
            images=len(images),
            cloud_placeholders=cloud_placeholder_count,
            reparse_dirs=reparse_dir_count,
            unreadable=unreadable_count,
        ),
    )


def _is_regular_file(st) -> bool:
    return _stat.S_ISREG(st.st_mode)


def _is_reparse_point(path: Path, st) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        return True
    attrs = _file_attributes(path, st)
    return bool(attrs & _REPARSE_POINT)


def _is_cloud_placeholder(st, path: Path | None = None) -> bool:
    attrs = _file_attributes(path, st)
    offline = getattr(_stat, "FILE_ATTRIBUTE_OFFLINE", 0x1000)
    return bool(attrs & (offline | _RECALL_ON_DATA_ACCESS))


def _file_attributes(path: Path | None, st) -> int:
    attrs = getattr(st, "st_file_attributes", 0) or 0
    if attrs or path is None or os.name != "nt":
        return int(attrs)
    try:
        import ctypes

        result = ctypes.windll.kernel32.GetFileAttributesW(str(path))
    except Exception:
        return 0
    if result == 0xFFFFFFFF:
        return 0
    return int(result)


def _windows_reparse_child_names(path: Path) -> set[str]:
    if os.name != "nt":
        return set()
    literal = str(path).replace("'", "''")
    script = (
        f"$p = '{literal}'; "
        "Get-ChildItem -LiteralPath $p -Force -Directory -ErrorAction SilentlyContinue | "
        "Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | "
        "ForEach-Object { $_.Name }"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return set()
    if result.returncode != 0:
        return set()
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def _emit_progress(
    progress_cb: Callable[..., None] | None,
    discovered: int,
    current_path: Path,
    cloud_placeholders: int,
    reparse_dirs: int,
) -> None:
    if not progress_cb:
        return
    try:
        progress_cb(discovered, str(current_path), cloud_placeholders, reparse_dirs)
    except TypeError:
        progress_cb(discovered)


def _mtime_iso(mtime: float | None) -> str | None:
    if mtime is None:
        return None
    return datetime.fromtimestamp(float(mtime)).replace(microsecond=0).isoformat()


def _parse_exif_datetime(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="ignore")
    text = str(value).strip().replace("\x00", "")
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).isoformat()
        except ValueError:
            continue
    return None


def _extract_taken_at_from_image(im: Image.Image, mtime: float | None) -> str | None:
    try:
        exif = im.getexif()
    except Exception:
        exif = None
    if exif:
        for tag in (36867, 306):
            parsed = _parse_exif_datetime(exif.get(tag))
            if parsed:
                return parsed
    return _mtime_iso(mtime)


def taken_at_for_path(path: Path, mtime: float | None = None) -> str | None:
    if mtime is None:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None
    try:
        stat_result = path.stat()
    except OSError:
        return _mtime_iso(mtime)
    if _is_cloud_placeholder(stat_result, path):
        return _mtime_iso(mtime)
    try:
        with Image.open(path) as im:
            return _extract_taken_at_from_image(im, mtime)
    except Exception:
        return _mtime_iso(mtime)
