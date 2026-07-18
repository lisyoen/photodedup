from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageEnhance, ImageDraw

from photodedup.grouping import GroupableImage, group_images
from photodedup.hashing import fingerprint
from photodedup.quality import quality_score
from photodedup.scanner import register_heif


def _write_sample_images(root: Path) -> tuple[Path, Path, Path]:
    image_a = Image.new("RGB", (128, 128), "#234f9a")
    draw = ImageDraw.Draw(image_a)
    draw.rectangle((18, 18, 104, 104), fill="#f5c542")
    draw.ellipse((42, 42, 92, 92), fill="#cf335f")

    path_a = root / "a.jpg"
    path_a_prime = root / "a_prime.jpg"
    path_b = root / "b.jpg"

    image_a.save(path_a, quality=95)
    image_a_prime = image_a.resize((96, 96)).resize((128, 128))
    image_a_prime = ImageEnhance.Brightness(image_a_prime).enhance(1.04)
    image_a_prime.save(path_a_prime, quality=92)

    image_b = Image.new("RGB", (128, 128), "#ffffff")
    draw_b = ImageDraw.Draw(image_b)
    for offset in range(0, 128, 8):
        color = "#111111" if offset % 16 == 0 else "#2ca58d"
        draw_b.line((0, offset, 127, 127 - offset), fill=color, width=3)
    image_b.save(path_b, quality=95)

    return path_a, path_a_prime, path_b


def test_core_hash_quality_grouping_and_heif_registration(tmp_path: Path) -> None:
    assert register_heif() is True

    paths = _write_sample_images(tmp_path)
    fingerprints = [fingerprint(path) for path in paths]
    qualities = []
    for path in paths:
        with Image.open(path) as im:
            score, sharpness = quality_score(
                path=path,
                width=im.width,
                height=im.height,
                size_bytes=path.stat().st_size,
                fmt=im.format or "JPEG",
            )
        assert isinstance(score, float)
        assert score > 0.0
        assert sharpness >= 0.0
        qualities.append(score)

    images = [
        GroupableImage(
            id=index + 1,
            phash=fp.phash,
            dhash=fp.dhash,
            histogram=fp.histogram,
            quality_score=qualities[index],
        )
        for index, fp in enumerate(fingerprints)
    ]

    groups = group_images(images, threshold=88)
    normalized = {frozenset(group) for group in groups}
    assert frozenset({1, 2}) in normalized
    assert all(len(group) >= 2 for group in groups)
    assert not any(3 in group for group in groups)
