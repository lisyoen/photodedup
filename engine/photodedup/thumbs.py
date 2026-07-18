from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageOps


def make_thumbnail(source: Path, thumbnails_dir: Path, image_id: int, max_side: int = 400) -> Path:
    thumbnails_dir.mkdir(parents=True, exist_ok=True)
    target = thumbnails_dir / f"{image_id}.jpg"
    with Image.open(source) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((max_side, max_side))
        im.save(target, "JPEG", quality=85, optimize=True)
    return target
