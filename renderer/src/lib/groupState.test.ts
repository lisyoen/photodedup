import { describe, expect, it } from "vitest";
import { applyGroupAction, deriveSelectionState, setImageMark, syncGroupState } from "./groupState";
import type { Image } from "../types";

const baseImages: Image[] = [
  {
    id: 1,
    path: "D:\\Photos\\IMG_0001.HEIC",
    size_bytes: 4_100_000,
    width: 4032,
    height: 3024,
    format: "heic",
    quality_score: 94.1,
    mark: "keep",
    recommended_keep: true,
    is_quarantined: false
  },
  {
    id: 2,
    path: "D:\\Photos\\IMG_0001-copy.JPG",
    size_bytes: 2_900_000,
    width: 4032,
    height: 3024,
    format: "jpg",
    quality_score: 81.5,
    mark: "none",
    recommended_keep: false,
    is_quarantined: false
  }
];

describe("groupState", () => {
  it("derives recommended_applied only when recommended is keep and all others are delete", () => {
    const images = applyGroupAction(baseImages.map((image) => ({ ...image, mark: "none" })), "apply_recommended");

    expect(images.map((image) => image.mark)).toEqual(["keep", "delete"]);
    expect(deriveSelectionState(images)).toBe("recommended_applied");
  });

  it("preserves multiple manual keep marks when applying recommended", () => {
    const images = applyGroupAction([
      { ...baseImages[0], mark: "keep" },
      { ...baseImages[1], mark: "keep" },
      { ...baseImages[1], id: 3, mark: "none" }
    ], "apply_recommended");
    const group = syncGroupState({
      id: 10,
      member_count: 3,
      recommended_keep_image_id: 1,
      selection_state: "mixed",
      max_similarity: 90,
      reclaimable_bytes: 0,
      thumbnail_image_id: 1,
      completed: false
    }, images);

    expect(images.map((image) => image.mark)).toEqual(["keep", "keep", "delete"]);
    expect(group.completed).toBe(true);
  });

  it("keeps the existing recommended behavior when no manual keep marks exist", () => {
    const images = applyGroupAction([
      { ...baseImages[0], mark: "none" },
      { ...baseImages[1], mark: "none" },
      { ...baseImages[1], id: 3, mark: "none" }
    ], "apply_recommended");

    expect(images.map((image) => image.mark)).toEqual(["keep", "delete", "delete"]);
    expect(deriveSelectionState(images)).toBe("recommended_applied");
  });

  it("does not add the recommended image when manual keep marks exclude it", () => {
    const images = applyGroupAction([
      { ...baseImages[0], mark: "none" },
      { ...baseImages[1], mark: "keep" },
      { ...baseImages[1], id: 3, mark: "keep" }
    ], "apply_recommended");

    expect(images.map((image) => image.mark)).toEqual(["delete", "keep", "keep"]);
    expect(deriveSelectionState(images)).toBe("mixed");
  });

  it("derives keep_all when every image is marked keep", () => {
    const images = applyGroupAction(baseImages, "keep_all");

    expect(images.every((image) => image.mark === "keep")).toBe(true);
    expect(deriveSelectionState(images)).toBe("keep_all");
  });

  it("derives delete_all when every image is marked delete", () => {
    const images = applyGroupAction(baseImages, "delete_all");

    expect(images.every((image) => image.mark === "delete")).toBe(true);
    expect(deriveSelectionState(images)).toBe("delete_all");
  });

  it("derives mixed when an individual image leaves the exact group action pattern", () => {
    const images = setImageMark(applyGroupAction(baseImages, "apply_recommended"), 2, "none");

    expect(deriveSelectionState(images)).toBe("mixed");
  });

  it("keeps image marks mutually exclusive by storing one mark value per image", () => {
    const kept = setImageMark(baseImages, 2, "keep");
    const deleted = setImageMark(kept, 2, "delete");
    const cleared = setImageMark(deleted, 2, "none");

    expect(kept.find((image) => image.id === 2)?.mark).toBe("keep");
    expect(deleted.find((image) => image.id === 2)?.mark).toBe("delete");
    expect(cleared.find((image) => image.id === 2)?.mark).toBe("none");
  });
});
