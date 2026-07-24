import { mockGroups } from "../mocks/groups";
import type { ApplyMode, GroupAction, GroupDetail, Group, Image, ImageMark } from "../types";
import { classifiedGroupIds } from "./groupClassification";
import { applyGroupAction as applyMockGroupAction, setImageMark, syncGroupState } from "./groupState";

export interface RendererSidecar {
  port: number;
  token: string;
}

export interface RendererShell {
  selectFolder(): Promise<string | null>;
  selectFolders?: () => Promise<string[]>;
  onTrayScanNow(callback: () => void): () => void;
  getAppVersion?: () => Promise<string>;
  getUpdateAvailability?: () => Promise<RendererUpdateStatus | null>;
  checkForUpdates?: () => Promise<RendererUpdateStatus | null>;
  openReleasePage?: (url: string) => Promise<void>;
  startUpdate?: () => Promise<{ ok: boolean; error?: string }>;
  restartAfterUpdate?: () => Promise<void>;
  onUpdateAvailable?: (callback: (update: RendererUpdateStatus) => void) => () => void;
  onUpdateProgress?: (callback: (progress: RendererUpdateProgress) => void) => () => void;
}

export interface RendererUpdateStatus {
  current: string;
  latest: string | null;
  htmlUrl: string | null;
  updateAvailable: boolean;
  isSourceInstall: boolean;
}

export interface RendererUpdateProgress {
  status: "running" | "succeeded" | "failed";
  stage: {
    id: string;
    label: string;
  };
  error?: string;
  logPath?: string;
}

declare global {
  interface Window {
    sidecar?: RendererSidecar;
    shell?: RendererShell;
  }
}

export interface ScanRequest {
  roots: string[];
}

export interface StartScanResponse {
  scan_id: string;
  status: JobStatusValue;
}

export interface HealthStatus {
  status: string;
  version: string;
  db_path: string;
  thumbs_dir: string;
  images: number;
  groups: number;
}

export type JobStatusValue = "queued" | "running" | "cancel_requested" | "done" | "error" | "cancelled";

export interface ScanStatus {
  scan_id: string;
  status: JobStatusValue;
  phase: "collecting" | "scanning" | "thumbnails" | "grouping" | "done" | "error";
  done: number;
  total: number;
  eta_sec?: number | null;
  cancellable: boolean;
  summary?: Record<string, unknown> | null;
  current_path?: string | null;
  cache_hits?: number;
  analyzed_new?: number;
  skipped?: {
    cloud_placeholders?: number;
    reparse_dirs?: number;
    unreadable?: number;
  };
}

export interface CleanupStatus {
  id: string;
  kind: "cleanup";
  status: JobStatusValue;
  phase: string;
  done: number;
  total: number;
  summary?: Record<string, unknown> | null;
  error?: string | null;
}

export interface GroupListResponse {
  items: Group[];
  next_cursor: string | null;
  total_estimate?: number | null;
}

export interface GroupDetailListResponse {
  items: GroupDetail[];
  next_cursor: string | null;
  total_estimate?: number | null;
}

export interface Settings {
  threshold: number;
  recursive: boolean;
  extensions: string[];
  cleanup_mode: ApplyMode;
  scan_folders?: string[];
  scan_folders_updated_at?: string | null;
  include_online_only?: boolean;
}

export interface CacheInfo {
  cache_dir: string;
  snapshot_count: number;
  snapshot_bytes: number;
}

export interface CacheClearResponse {
  removed: number;
}

export interface GroupSnapshot {
  version: number;
  generated_at: string;
  roots: string[];
  items: GroupDetail[];
}

export type GroupStatusFilter = "unresolved" | "processed" | "all";
export type GroupSortFilter = "savings" | "similarity" | "quality";

export interface GroupListOptions {
  status: GroupStatusFilter;
  sort: GroupSortFilter;
}

export interface DataSource {
  readonly kind: "http" | "mock";
  getHealth(): Promise<HealthStatus>;
  startScan(request: ScanRequest): Promise<StartScanResponse>;
  getScan(scanId: string): Promise<ScanStatus>;
  cancelScan(scanId: string): Promise<StartScanResponse>;
  listGroups(roots?: string[], options?: GroupListOptions): Promise<GroupListResponse>;
  listGroupDetails(roots?: string[], options?: GroupListOptions): Promise<GroupDetailListResponse>;
  getGroup(groupId: number, roots?: string[]): Promise<GroupDetail>;
  loadGroupSnapshot(roots?: string[]): Promise<GroupSnapshot | null>;
  updateImage(imageId: number, mark: ImageMark): Promise<Image>;
  applyGroupAction(groupId: number, action: GroupAction): Promise<GroupDetail>;
  applyMarkedDeletes(mode: ApplyMode, groupIds?: number[]): Promise<{ job_id: string; status: JobStatusValue; targets: number }>;
  getCleanup(jobId: string): Promise<CleanupStatus>;
  getSettings(): Promise<Settings>;
  putSettings(settings: Settings): Promise<Settings>;
  getCacheInfo(): Promise<CacheInfo>;
  clearCache(): Promise<CacheClearResponse>;
  thumbUrl(imageId: number): string | null;
  loadThumbSrc(image: Image): Promise<string>;
  loadFullSrc(image: Image): Promise<string>;
  disposeThumbs(): void;
}

export class HttpDataSource implements DataSource {
  readonly kind = "http";
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly thumbCache = new Map<number, string>();
  private readonly fullImageCache = new Map<number, string>();

  constructor(sidecar: RendererSidecar) {
    this.baseUrl = `http://127.0.0.1:${sidecar.port}`;
    this.token = sidecar.token;
  }

  getHealth(): Promise<HealthStatus> {
    return this.request("/healthz");
  }

  startScan(request: ScanRequest): Promise<StartScanResponse> {
    return this.request("/scan", {
      method: "POST",
      body: JSON.stringify({ roots: request.roots }),
    });
  }

  getScan(scanId: string): Promise<ScanStatus> {
    return this.request(`/scan/${encodeURIComponent(scanId)}`);
  }

  cancelScan(scanId: string): Promise<StartScanResponse> {
    return this.request(`/scan/${encodeURIComponent(scanId)}/cancel`, { method: "POST" });
  }

  listGroups(roots?: string[], options: GroupListOptions = { status: "unresolved", sort: "savings" }): Promise<GroupListResponse> {
    return this.request(this.groupListPath(roots, options, undefined, 200));
  }

  listGroupDetails(roots?: string[], options: GroupListOptions = { status: "unresolved", sort: "savings" }): Promise<GroupDetailListResponse> {
    return this.request(this.groupListPath(roots, options, "details", 10000));
  }

  private groupListPath(roots?: string[], options: GroupListOptions = { status: "unresolved", sort: "savings" }, include?: "details", limit = 200): string {
    const sort = options.sort === "savings" ? "reclaimable_bytes" : options.sort;
    const params = new URLSearchParams({
      limit: String(limit),
      sort,
      status: options.status,
    });
    if (include) params.set("include", include);
    roots?.forEach((root) => params.append("roots", root));
    return `/groups?${params.toString()}`;
  }

  getGroup(groupId: number, roots?: string[]): Promise<GroupDetail> {
    const params = new URLSearchParams();
    roots?.forEach((root) => params.append("roots", root));
    const query = params.toString();
    return this.request(`/groups/${groupId}${query ? `?${query}` : ""}`);
  }

  async loadGroupSnapshot(roots?: string[]): Promise<GroupSnapshot | null> {
    const params = new URLSearchParams();
    roots?.forEach((root) => params.append("roots", root));
    const query = params.toString();
    try {
      return await this.request(`/groups/snapshot${query ? `?${query}` : ""}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("failed with 404")) {
        return null;
      }
      throw error;
    }
  }

  async updateImage(imageId: number, mark: ImageMark): Promise<Image> {
    const response = await this.request<{ image: Image }>(`/images/${imageId}`, {
      method: "PATCH",
      body: JSON.stringify({ mark }),
    });
    return response.image;
  }

  applyGroupAction(groupId: number, action: GroupAction): Promise<GroupDetail> {
    return this.request(`/groups/${groupId}/action`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
  }

  applyMarkedDeletes(mode: ApplyMode, groupIds?: number[]): Promise<{ job_id: string; status: JobStatusValue; targets: number }> {
    return this.request("/apply", {
      method: "POST",
      body: JSON.stringify({ mode, ...(groupIds ? { group_ids: groupIds } : {}) }),
    });
  }

  getCleanup(jobId: string): Promise<CleanupStatus> {
    return this.request(`/cleanup/${encodeURIComponent(jobId)}`);
  }

  getSettings(): Promise<Settings> {
    return this.request("/settings");
  }

  putSettings(settings: Settings): Promise<Settings> {
    return this.request("/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  }

  getCacheInfo(): Promise<CacheInfo> {
    return this.request("/cache/info");
  }

  clearCache(): Promise<CacheClearResponse> {
    return this.request("/cache/clear", { method: "POST" });
  }

  thumbUrl(imageId: number): string {
    return `${this.baseUrl}/thumbs/${imageId}`;
  }

  async loadThumbSrc(image: Image): Promise<string> {
    const cached = this.thumbCache.get(image.id);
    if (cached) return cached;

    const response = await fetch(this.thumbUrl(image.id), {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`GET /thumbs/${image.id} failed with ${response.status}`);
    }

    const objectUrl = URL.createObjectURL(await response.blob());
    this.thumbCache.set(image.id, objectUrl);
    return objectUrl;
  }

  async loadFullSrc(image: Image): Promise<string> {
    const cached = this.fullImageCache.get(image.id);
    if (cached) return cached;

    const response = await fetch(`${this.baseUrl}/images/${image.id}/full`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`GET /images/${image.id}/full failed with ${response.status}`);
    }

    const objectUrl = URL.createObjectURL(await response.blob());
    this.fullImageCache.set(image.id, objectUrl);
    return objectUrl;
  }

  disposeThumbs(): void {
    for (const url of this.thumbCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.thumbCache.clear();
    for (const url of this.fullImageCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.fullImageCache.clear();
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers(),
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Api-Token": this.token,
    };
  }
}

export class MockDataSource implements DataSource {
  readonly kind = "mock";
  private groups: GroupDetail[] = cloneGroups(mockGroups);
  private scan: ScanStatus | null = null;

  async getHealth(): Promise<HealthStatus> {
    return {
      status: "ok",
      version: "mock",
      db_path: "mock://manifest.db",
      thumbs_dir: "mock://thumbs",
      images: this.groups.reduce((total, group) => total + group.images.length, 0),
      groups: this.groups.length,
    };
  }

  async startScan(_request: ScanRequest): Promise<StartScanResponse> {
    this.scan = {
      scan_id: "mock-scan",
      status: "done",
      phase: "done",
      done: this.groups.reduce((total, group) => total + group.images.length, 0),
      total: this.groups.reduce((total, group) => total + group.images.length, 0),
      cancellable: false,
    };
    return { scan_id: this.scan.scan_id, status: this.scan.status };
  }

  async getScan(scanId: string): Promise<ScanStatus> {
    return this.scan ?? {
      scan_id: scanId,
      status: "done",
      phase: "done",
      done: 0,
      total: 0,
      cancellable: false,
    };
  }

  async cancelScan(scanId: string): Promise<StartScanResponse> {
    this.scan = {
      scan_id: scanId,
      status: "cancelled",
      phase: "done",
      done: 0,
      total: 0,
      cancellable: false,
    };
    return { scan_id: scanId, status: "cancelled" };
  }

  async listGroups(roots?: string[], options: GroupListOptions = { status: "unresolved", sort: "savings" }): Promise<GroupListResponse> {
    void roots;
    const items = this.groups
      .map((detail) => detail.group)
      .sort((left, right) => {
        if (options.sort === "similarity") return (right.max_similarity ?? 0) - (left.max_similarity ?? 0);
        if (options.sort === "quality") return (right.recommended_keep_image_id ?? 0) - (left.recommended_keep_image_id ?? 0);
        return right.reclaimable_bytes - left.reclaimable_bytes;
      });
    return { items, next_cursor: null, total_estimate: items.length };
  }

  async listGroupDetails(roots?: string[], options: GroupListOptions = { status: "unresolved", sort: "savings" }): Promise<GroupDetailListResponse> {
    void roots;
    const items = this.groups
      .map(cloneGroup)
      .sort((left, right) => {
        if (options.sort === "similarity") return (right.group.max_similarity ?? 0) - (left.group.max_similarity ?? 0);
        if (options.sort === "quality") return (right.group.recommended_keep_image_id ?? 0) - (left.group.recommended_keep_image_id ?? 0);
        return right.group.reclaimable_bytes - left.group.reclaimable_bytes;
      });
    return { items, next_cursor: null, total_estimate: items.length };
  }

  async getGroup(groupId: number, roots?: string[]): Promise<GroupDetail> {
    void roots;
    const detail = this.findGroup(groupId);
    return cloneGroup(detail);
  }

  async loadGroupSnapshot(roots?: string[]): Promise<GroupSnapshot | null> {
    void roots;
    return null;
  }

  async updateImage(imageId: number, mark: ImageMark): Promise<Image> {
    for (const detail of this.groups) {
      if (detail.images.some((image) => image.id === imageId)) {
        const images = setImageMark(detail.images, imageId, mark);
        detail.images = images;
        detail.group = syncGroupState(detail.group, images);
        return cloneImage(images.find((image) => image.id === imageId)!);
      }
    }
    throw new Error(`image not found: ${imageId}`);
  }

  async applyGroupAction(groupId: number, action: GroupAction): Promise<GroupDetail> {
    const detail = this.findGroup(groupId);
    const images = applyMockGroupAction(detail.images, action);
    detail.images = images;
    detail.group = syncGroupState(detail.group, images);
    return cloneGroup(detail);
  }

  async applyMarkedDeletes(mode: ApplyMode, groupIds?: number[]): Promise<{ job_id: string; status: JobStatusValue; targets: number }> {
    const targetGroupIds = groupIds ?? classifiedGroupIds(this.groups);
    const targets = this.groups
      .filter(({ group }) => targetGroupIds.includes(group.id))
      .flatMap((group) => group.images)
      .filter((image) => image.mark === "delete").length;
    void mode;
    return { job_id: "mock-cleanup", status: "done", targets };
  }

  async getCleanup(jobId: string): Promise<CleanupStatus> {
    return {
      id: jobId,
      kind: "cleanup",
      status: "done",
      phase: "done",
      done: 0,
      total: 0,
      summary: { deleted: 0, failed: 0 },
    };
  }

  async getSettings(): Promise<Settings> {
    return {
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
      scan_folders: [],
      include_online_only: false,
    };
  }

  async putSettings(settings: Settings): Promise<Settings> {
    return settings;
  }

  async getCacheInfo(): Promise<CacheInfo> {
    return {
      cache_dir: "mock://cache",
      snapshot_count: 0,
      snapshot_bytes: 0,
    };
  }

  async clearCache(): Promise<CacheClearResponse> {
    return { removed: 0 };
  }

  thumbUrl(): string | null {
    return null;
  }

  async loadThumbSrc(image: Image): Promise<string> {
    return placeholderFor(image);
  }

  async loadFullSrc(image: Image): Promise<string> {
    return placeholderFor(image);
  }

  disposeThumbs(): void {}

  private findGroup(groupId: number): GroupDetail {
    const detail = this.groups.find(({ group }) => group.id === groupId);
    if (!detail) throw new Error(`group not found: ${groupId}`);
    return detail;
  }
}

export class EngineConnectionError extends Error {
  constructor() {
    super("Electron renderer is missing the sidecar preload bridge.");
    this.name = "EngineConnectionError";
  }
}

export function createDataSource(sidecar = window.sidecar): DataSource {
  if (sidecar) {
    return new HttpDataSource(sidecar);
  }
  if (isElectronRuntime()) {
    throw new EngineConnectionError();
  }
  return new MockDataSource();
}

export function isElectronRuntime(userAgent = navigator.userAgent): boolean {
  return userAgent.includes("Electron");
}

export function placeholderFor(image: Image): string {
  const label = `${fileName(image.path)} | ${image.width ?? "-"}x${image.height ?? "-"}`;
  const hue = (image.id * 37) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="hsl(${hue},62%,44%)"/><stop offset="1" stop-color="hsl(${(hue + 78) % 360},56%,18%)"/></linearGradient></defs><rect width="640" height="420" fill="url(#g)"/><rect x="32" y="32" width="576" height="356" rx="18" fill="rgba(0,0,0,.18)" stroke="rgba(255,255,255,.28)"/><text x="48" y="196" fill="white" font-family="Arial, sans-serif" font-size="30" font-weight="700">${escapeSvg(fileName(image.path))}</text><text x="48" y="240" fill="rgba(255,255,255,.86)" font-family="Arial, sans-serif" font-size="24">${escapeSvg(label)}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function cloneGroups(groups: GroupDetail[]): GroupDetail[] {
  return groups.map(cloneGroup);
}

function cloneGroup(detail: GroupDetail): GroupDetail {
  return {
    group: { ...detail.group },
    images: detail.images.map(cloneImage),
  };
}

function cloneImage(image: Image): Image {
  return { ...image };
}

function fileName(path: string): string {
  return path.split("\\").pop() ?? path.split("/").pop() ?? path;
}

function escapeSvg(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[char];
  });
}
