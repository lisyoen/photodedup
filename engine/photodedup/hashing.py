from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ImageFingerprint:
    phash: str
    dhash: str
    histogram: list[float]


def _load_rgb(path: Path):
    from PIL import Image, ImageOps

    with Image.open(path) as im:
        return ImageOps.exif_transpose(im).convert("RGB")


def color_histogram(path: Path) -> list[float]:
    import numpy as np

    with _load_rgb(path) as pil:
        hsv = pil.convert("HSV")
        arr = np.array(hsv)
    hist, _ = np.histogramdd(
        arr.reshape(-1, 3),
        bins=(8, 8, 8),
        range=((0, 256), (0, 256), (0, 256)),
    )
    norm = float(np.linalg.norm(hist))
    if norm:
        hist = hist / norm
    hist = hist.flatten()
    return [float(x) for x in hist]


def fingerprint(path: Path) -> ImageFingerprint:
    import imagehash

    with _load_rgb(path) as im:
        phash = str(imagehash.phash(im))
        dhash = str(imagehash.dhash(im))
    return ImageFingerprint(phash=phash, dhash=dhash, histogram=color_histogram(path))


def hamming_similarity(left_hex: str, right_hex: str) -> float:
    left = int(left_hex, 16)
    right = int(right_hex, 16)
    bits = max(len(left_hex), len(right_hex)) * 4
    return max(0.0, 1.0 - ((left ^ right).bit_count() / bits))


def histogram_correlation(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    left_delta = [value - left_mean for value in left]
    right_delta = [value - right_mean for value in right]
    numerator = sum(a * b for a, b in zip(left_delta, right_delta))
    left_norm = sum(value * value for value in left_delta) ** 0.5
    right_norm = sum(value * value for value in right_delta) ** 0.5
    if left_norm == 0.0 or right_norm == 0.0:
        corr = 1.0 if left == right else 0.0
    else:
        corr = numerator / (left_norm * right_norm)
    return max(0.0, min(1.0, (corr + 1.0) / 2.0))


def similarity_percent(
    left_phash: str,
    left_dhash: str,
    left_histogram: list[float],
    right_phash: str,
    right_dhash: str,
    right_histogram: list[float],
) -> float:
    """Return a 0..100 near-duplicate score.

    Formula:
      score = 100 * (0.40 * pHash_similarity
                   + 0.35 * dHash_similarity
                   + 0.25 * histogram_correlation)

    pHash/dHash similarities are normalized Hamming similarities over the hash
    bit count. Histogram correlation is OpenCV correlation normalized from
    [-1, 1] into [0, 1].
    """

    ph = hamming_similarity(left_phash, right_phash)
    dh = hamming_similarity(left_dhash, right_dhash)
    hc = histogram_correlation(left_histogram, right_histogram)
    return 100.0 * ((0.40 * ph) + (0.35 * dh) + (0.25 * hc))


def hash_distance(left_hex: str, right_hex: str) -> int:
    return (int(left_hex, 16) ^ int(right_hex, 16)).bit_count()
