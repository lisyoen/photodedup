export type ImageMark = "keep" | "delete" | "none";

export type SelectionState =
  | "recommended_applied"
  | "keep_all"
  | "delete_all"
  | "mixed";

export interface Image {
  id: number;
  path: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  format: string | null;
  quality_score: number | null;
  sharpness?: number | null;
  taken_at?: string | null;
  similarity_to_recommended?: number | null;
  mark: ImageMark;
  recommended_keep: boolean;
  is_quarantined: boolean;
}

export interface Group {
  id: number;
  member_count: number;
  recommended_keep_image_id: number | null;
  selection_state: SelectionState;
  max_similarity: number | null;
  reclaimable_bytes: number;
  thumbnail_image_id: number | null;
  cover_image_id?: number | null;
  marked_count?: number;
  total_count?: number;
  completed?: boolean;
}

export interface GroupDetail {
  group: Group;
  images: Image[];
}

export type GroupAction = "apply_recommended" | "keep_all" | "delete_all";
export type ApplyMode = "trash" | "permanent";
