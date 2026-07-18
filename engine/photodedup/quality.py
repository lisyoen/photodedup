from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ExifTags, ImageOps

QUALITY_WEIGHTS = {
    "resolution": 0.70,
    "sharpness": 0.20,
    "file_size": 0.05,
    "original_bonus": 0.05,
}

RAW_EXTENSIONS = {".arw", ".cr2", ".cr3", ".dng", ".nef", ".orf", ".raf", ".rw2"}
ORIGINAL_FORMATS = {"HEIC", "HEIF"}


def sharpness_score(path: Path) -> float:
    with Image.open(path) as im:
        gray = ImageOps.exif_transpose(im).convert("L")
        arr = np.array(gray, dtype=np.float64)
    padded = np.pad(arr, 1, mode="edge")
    laplacian = (
        padded[:-2, 1:-1]
        + padded[2:, 1:-1]
        + padded[1:-1, :-2]
        + padded[1:-1, 2:]
        - (4.0 * arr)
    )
    return float(laplacian.var())


def has_original_capture_info(path: Path, fmt: str) -> bool:
    if path.suffix.lower() in RAW_EXTENSIONS or fmt.upper() in ORIGINAL_FORMATS:
        return True
    try:
        with Image.open(path) as im:
            exif = im.getexif()
        if not exif:
            return False
        names = {ExifTags.TAGS.get(key, key): value for key, value in exif.items()}
        return any(key in names for key in ("DateTimeOriginal", "DateTimeDigitized", "Make", "Model"))
    except Exception:
        return False


def quality_score(
    *,
    path: Path,
    width: int,
    height: int,
    size_bytes: int,
    fmt: str,
    sharpness: float | None = None,
) -> tuple[float, float]:
    sharp = sharpness_score(path) if sharpness is None else sharpness
    megapixels = (width * height) / 1_000_000.0
    size_mb = size_bytes / 1_000_000.0
    original = 1.0 if has_original_capture_info(path, fmt) else 0.0

    score = (
        QUALITY_WEIGHTS["resolution"] * megapixels
        + QUALITY_WEIGHTS["sharpness"] * np.log1p(max(sharp, 0.0))
        + QUALITY_WEIGHTS["file_size"] * np.log1p(max(size_mb, 0.0))
        + QUALITY_WEIGHTS["original_bonus"] * original
    )
    return float(score), float(sharp)


def choose_keep(image_ids: list[int], quality_scores: dict[int, float]) -> int:
    return max(image_ids, key=lambda image_id: (quality_scores[image_id], image_id))
