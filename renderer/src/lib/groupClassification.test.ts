import { describe, expect, it } from "vitest";
import { classifiedGroupIds, isClassifiedGroup, markedCount, unclassifiedGroupCount } from "./groupClassification";
import type { GroupDetail, ImageMark } from "../types";

describe("group classification", () => {
  it("treats fully marked groups as classified and partial groups as unclassified", () => {
    expect(isClassifiedGroup(group(1, ["keep", "delete"]))).toBe(true);
    expect(isClassifiedGroup(group(2, ["keep", "none"]))).toBe(false);
    expect(isClassifiedGroup(group(3, ["none", "none"]))).toBe(false);
    expect(markedCount(group(2, ["keep", "none"]).images)).toBe(1);
  });

  it("uses persisted completion when the engine provides it", () => {
    expect(isClassifiedGroup(group(1, ["none", "none"], true))).toBe(true);
    expect(isClassifiedGroup(group(2, ["keep", "delete"], false))).toBe(false);
  });

  it("returns only classified group ids for apply scope", () => {
    const groups = [
      group(1, ["none", "none"], true),
      group(2, ["keep", "none"]),
      group(3, ["delete", "delete"]),
    ];

    expect(classifiedGroupIds(groups)).toEqual([1, 3]);
    expect(unclassifiedGroupCount(groups)).toBe(1);
  });
});

function group(id: number, marks: ImageMark[], completed?: boolean): GroupDetail {
  return {
    group: {
      id,
      member_count: marks.length,
      recommended_keep_image_id: id * 10,
      selection_state: "mixed",
      max_similarity: 95,
      reclaimable_bytes: 0,
      thumbnail_image_id: id * 10,
      cover_image_id: id * 10,
      marked_count: marks.filter((mark) => mark !== "none").length,
      total_count: marks.length,
      completed,
    },
    images: marks.map((mark, index) => ({
      id: id * 10 + index,
      path: `D:\\Photos\\${id}-${index}.jpg`,
      size_bytes: 100,
      width: 10,
      height: 10,
      format: "jpg",
      quality_score: 90,
      mark,
      recommended_keep: index === 0,
      is_quarantined: false,
    })),
  };
}
