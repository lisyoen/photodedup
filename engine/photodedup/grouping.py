from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

from .hashing import hash_distance, histogram_correlation, similarity_percent

LOGGER = logging.getLogger(__name__)
ProgressCallback = Callable[[int, int, str], None]
HASH_BITS = 64
PHASH_WEIGHT = 0.40
DHASH_WEIGHT = 0.35
HISTOGRAM_WEIGHT = 0.25


@dataclass(frozen=True)
class GroupableImage:
    id: int
    phash: str
    dhash: str
    histogram: list[float]
    quality_score: float


class UnionFind:
    def __init__(self, values: list[int]) -> None:
        self.parent = {value: value for value in values}

    def find(self, value: int) -> int:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, left: int, right: int) -> None:
        a = self.find(left)
        b = self.find(right)
        if a != b:
            self.parent[max(a, b)] = min(a, b)


class BKTree:
    def __init__(self) -> None:
        self.root: tuple[GroupableImage, dict[int, object]] | None = None

    def add(self, item: GroupableImage) -> None:
        if self.root is None:
            self.root = (item, {})
            return
        node_item, children = self.root
        while True:
            distance = hash_distance(item.phash, node_item.phash)
            child = children.get(distance)
            if child is None:
                children[distance] = (item, {})
                return
            node_item, children = child  # type: ignore[assignment]

    def query(self, item: GroupableImage, max_distance: int) -> list[GroupableImage]:
        if self.root is None:
            return []
        matches: list[GroupableImage] = []
        pending = [self.root]
        while pending:
            node_item, children = pending.pop()
            distance = hash_distance(item.phash, node_item.phash)
            if distance <= max_distance:
                matches.append(node_item)
            low = distance - max_distance
            high = distance + max_distance
            for edge, child in children.items():
                if low <= edge <= high:
                    pending.append(child)  # type: ignore[arg-type]
        return matches


def _weighted_hash_distance(left: GroupableImage, right: GroupableImage) -> float:
    return (PHASH_WEIGHT * hash_distance(left.phash, right.phash)) + (
        DHASH_WEIGHT * hash_distance(left.dhash, right.dhash)
    )


def _max_weighted_hash_distance(threshold: int) -> float:
    return HASH_BITS * (1.0 - (threshold / 100.0))


def _score_upper_bound(left: GroupableImage, right: GroupableImage) -> float:
    weighted_distance = _weighted_hash_distance(left, right)
    return 100.0 * (1.0 - (weighted_distance / HASH_BITS))


def _score(left: GroupableImage, right: GroupableImage, threshold: int | None = None) -> float:
    if threshold is not None and _score_upper_bound(left, right) < threshold:
        return 0.0
    return similarity_percent(
        left.phash,
        left.dhash,
        left.histogram,
        right.phash,
        right.dhash,
        right.histogram,
    )


def _score_meets_threshold(left: GroupableImage, right: GroupableImage, threshold: int) -> bool:
    if _score_upper_bound(left, right) < threshold:
        return False
    return _score(left, right) >= threshold


def threshold_to_max_distance(threshold: int) -> int:
    if threshold >= 100:
        return 0
    if threshold <= 0:
        return HASH_BITS
    return min(HASH_BITS, int(_max_weighted_hash_distance(threshold) // PHASH_WEIGHT))


def _emit_progress(
    progress_cb: ProgressCallback | None,
    processed: int,
    total: int,
    *,
    force: bool = False,
    last_emit: float = 0.0,
) -> float:
    if progress_cb is None:
        return last_emit
    now = time.monotonic()
    if force or processed == total or processed % 200 == 0 or (now - last_emit) >= 0.5:
        progress_cb(processed, total, "grouping")
        return now
    return last_emit


def _histogram_score(left: GroupableImage, right: GroupableImage, phash_distance: int, dhash_distance: int) -> float:
    ph = max(0.0, 1.0 - (phash_distance / HASH_BITS))
    dh = max(0.0, 1.0 - (dhash_distance / HASH_BITS))
    hc = histogram_correlation(left.histogram, right.histogram)
    return 100.0 * ((PHASH_WEIGHT * ph) + (DHASH_WEIGHT * dh) + (HISTOGRAM_WEIGHT * hc))


def _group_images_vectorized(
    images: list[GroupableImage],
    threshold: int,
    uf: UnionFind,
    progress_cb: ProgressCallback | None,
) -> None:
    import numpy as np

    total = len(images)
    phashes = np.array([int(image.phash, 16) for image in images], dtype=np.uint64)
    dhashes = np.array([int(image.dhash, 16) for image in images], dtype=np.uint64)
    popcount_lut = np.array([int(value).bit_count() for value in range(256)], dtype=np.uint8)
    max_weighted = _max_weighted_hash_distance(threshold)
    last_emit = time.monotonic()

    for index, image in enumerate(images):
        if index:
            ph_xor = np.bitwise_xor(phashes[:index], phashes[index])
            dh_xor = np.bitwise_xor(dhashes[:index], dhashes[index])
            ph_dist = popcount_lut[ph_xor.view(np.uint8).reshape(-1, 8)].sum(axis=1, dtype=np.uint16)
            dh_dist = popcount_lut[dh_xor.view(np.uint8).reshape(-1, 8)].sum(axis=1, dtype=np.uint16)
            weighted = (PHASH_WEIGHT * ph_dist) + (DHASH_WEIGHT * dh_dist)
            candidate_indexes = np.flatnonzero(weighted <= max_weighted)
            for candidate_index in candidate_indexes.tolist():
                candidate = images[candidate_index]
                score = _histogram_score(
                    image,
                    candidate,
                    int(ph_dist[candidate_index]),
                    int(dh_dist[candidate_index]),
                )
                if score >= threshold:
                    uf.union(image.id, candidate.id)
        last_emit = _emit_progress(progress_cb, index + 1, total, last_emit=last_emit)


def _group_images_bktree(
    images: list[GroupableImage],
    threshold: int,
    uf: UnionFind,
    progress_cb: ProgressCallback | None,
) -> None:
    total = len(images)
    tree = BKTree()
    max_distance = threshold_to_max_distance(threshold)
    last_emit = time.monotonic()

    for index, image in enumerate(images, start=1):
        for candidate in tree.query(image, max_distance):
            if candidate.id != image.id and _score_meets_threshold(image, candidate, threshold):
                uf.union(image.id, candidate.id)
        tree.add(image)
        last_emit = _emit_progress(progress_cb, index, total, last_emit=last_emit)


def group_images(
    images: list[GroupableImage],
    threshold: int = 90,
    progress_cb: ProgressCallback | None = None,
) -> list[list[int]]:
    if not images:
        return []

    start = time.monotonic()
    LOGGER.info("grouping start: images=%d threshold=%d", len(images), threshold)
    uf = UnionFind([image.id for image in images])
    _emit_progress(progress_cb, 0, len(images), force=True)

    try:
        _group_images_vectorized(images, threshold, uf, progress_cb)
    except ImportError:
        LOGGER.info("numpy unavailable; falling back to BK-tree grouping")
        _group_images_bktree(images, threshold, uf, progress_cb)

    by_root: dict[int, list[GroupableImage]] = {}
    for image in images:
        by_root.setdefault(uf.find(image.id), []).append(image)

    final_groups: list[list[int]] = []
    for members in by_root.values():
        if len(members) == 1:
            continue
        representative = max(members, key=lambda item: (item.quality_score, item.id))
        confirmed = [representative.id]
        for member in members:
            if member.id == representative.id:
                continue
            if _score_meets_threshold(representative, member, threshold):
                confirmed.append(member.id)
        if len(confirmed) >= 2:
            final_groups.append(sorted(confirmed))

    groups = sorted(final_groups, key=lambda group: (min(group), len(group)))
    _emit_progress(progress_cb, len(images), len(images), force=True)
    LOGGER.info(
        "grouping done: images=%d threshold=%d groups=%d elapsed=%.2fs",
        len(images),
        threshold,
        len(groups),
        time.monotonic() - start,
    )
    return groups
