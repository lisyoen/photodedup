import { deriveSelectionState, syncGroupState } from "../lib/groupState";
import type { Group, GroupDetail, Image } from "../types";

const roots = [
  "D:\\Photos\\2024\\Family",
  "D:\\Photos\\2023\\Travel",
  "E:\\Camera\\RAW",
  "C:\\Users\\me\\Pictures\\Phone"
];

const names = [
  "IMG_0420.HEIC",
  "IMG_0420-copy.JPG",
  "DSC_1108.ARW",
  "PXL_20240501_091204.jpg",
  "Vacation-Edit.webp",
  "Birthday-final.png"
];

export const mockGroups: GroupDetail[] = Array.from({ length: 10 }, (_, groupIndex) => {
  const count = 2 + (groupIndex % 5);
  const recommendedIndex = groupIndex % count;
  const images: Image[] = Array.from({ length: count }, (_, imageIndex) => {
    const id = groupIndex * 100 + imageIndex + 1;
    const width = imageIndex % 3 === 0 ? 4032 : imageIndex % 3 === 1 ? 3024 : 2560;
    const height = imageIndex % 2 === 0 ? 3024 : 2268;
    const size_bytes = 1_350_000 + groupIndex * 420_000 + imageIndex * 530_000;
    const recommended_keep = imageIndex === recommendedIndex;

    return {
      id,
      path: `${roots[groupIndex % roots.length]}\\G${String(groupIndex + 1).padStart(2, "0")}_${names[imageIndex % names.length]}`,
      size_bytes,
      width,
      height,
      format: names[imageIndex % names.length].split(".").pop()?.toLowerCase() ?? "jpg",
      quality_score: Math.round((96 - imageIndex * 6.7 - groupIndex * 1.3) * 10) / 10,
      sharpness: Math.round((82 - imageIndex * 4.2) * 10) / 10,
      taken_at: `2024-05-${String(1 + groupIndex).padStart(2, "0")}T09:${String(12 + imageIndex).padStart(2, "0")}:00Z`,
      mark: recommended_keep ? "keep" : "none",
      recommended_keep,
      is_quarantined: false
    };
  });

  const group: Group = {
    id: 184 - groupIndex * 3,
    member_count: images.length,
    recommended_keep_image_id: images[recommendedIndex].id,
    selection_state: deriveSelectionState(images),
    max_similarity: Math.round((98.4 - groupIndex * 0.9) * 10) / 10,
    reclaimable_bytes: 0,
    thumbnail_image_id: images[0].id
  };

  return {
    group: syncGroupState(group, images),
    images
  };
});
