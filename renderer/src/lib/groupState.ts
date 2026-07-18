import type { Group, GroupAction, Image, ImageMark, SelectionState } from "../types";

export function deriveSelectionState(images: Image[]): SelectionState {
  if (images.length === 0) {
    return "mixed";
  }

  if (images.every((image) => image.mark === "keep")) {
    return "keep_all";
  }

  if (images.every((image) => image.mark === "delete")) {
    return "delete_all";
  }

  const recommendedMatches = images.every((image) =>
    image.recommended_keep ? image.mark === "keep" : image.mark === "delete"
  );

  return recommendedMatches ? "recommended_applied" : "mixed";
}

export function applyGroupAction(images: Image[], action: GroupAction): Image[] {
  const manualKeepIds = action === "apply_recommended"
    ? new Set(images.filter((image) => image.mark === "keep").map((image) => image.id))
    : null;

  return images.map((image) => ({
    ...image,
    mark: markForAction(image, action, manualKeepIds)
  }));
}

export function setImageMark(images: Image[], imageId: number, mark: ImageMark): Image[] {
  return images.map((image) => (image.id === imageId ? { ...image, mark } : image));
}

export function syncGroupState(group: Group, images: Image[]): Group {
  return {
    ...group,
    member_count: images.length,
    recommended_keep_image_id: images.find((image) => image.recommended_keep)?.id ?? null,
    selection_state: deriveSelectionState(images),
    reclaimable_bytes: calculateReclaimableBytes(images),
    thumbnail_image_id: images[0]?.id ?? null,
    cover_image_id: images[0]?.id ?? null,
    marked_count: images.filter((image) => image.mark === "keep" || image.mark === "delete").length,
    total_count: images.length,
    completed: group.completed === true || images.some((image) => image.mark === "keep" || image.mark === "delete")
  };
}

export function calculateReclaimableBytes(images: Image[]): number {
  return images
    .filter((image) => image.mark === "delete")
    .reduce((total, image) => total + image.size_bytes, 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`;
}

function markForAction(image: Image, action: GroupAction, manualKeepIds: Set<number> | null = null): ImageMark {
  if (action === "keep_all") return "keep";
  if (action === "delete_all") return "delete";
  if (manualKeepIds && manualKeepIds.size > 0) {
    return manualKeepIds.has(image.id) ? "keep" : "delete";
  }
  return image.recommended_keep ? "keep" : "delete";
}
