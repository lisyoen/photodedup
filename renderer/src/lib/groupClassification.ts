import type { GroupDetail, Image } from "../types";

export function markedCount(images: Image[]): number {
  return images.filter((image) => image.mark === "keep" || image.mark === "delete").length;
}

export function isClassifiedGroup(detail: GroupDetail): boolean {
  if (typeof detail.group.completed === "boolean") {
    return detail.group.completed;
  }

  return detail.images.length > 0 && markedCount(detail.images) === detail.images.length;
}

export function classifiedGroupIds(groups: GroupDetail[]): number[] {
  return groups.filter(isClassifiedGroup).map(({ group }) => group.id);
}

export function unclassifiedGroupCount(groups: GroupDetail[]): number {
  return groups.length - classifiedGroupIds(groups).length;
}
