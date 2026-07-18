export const LANGUAGE_STORAGE_KEY = "pdd.settings.language";
export const SCAN_FOLDERS_STORAGE_KEY = "pdd.settings.scanFolders";
export const SCAN_FOLDERS_UPDATED_AT_STORAGE_KEY = "pdd.settings.scanFoldersUpdatedAt";
export const BACKGROUND_SCAN_INTERVAL_STORAGE_KEY = "pdd.settings.backgroundScanIntervalHours";
export const BACKGROUND_SCAN_LAST_STARTED_STORAGE_KEY = "pdd.settings.backgroundScanLastStartedAt";
export const QUICK_SELECT_STORAGE_KEY = "pdd.settings.quickSelectEnabled";
export const THUMBNAIL_ZOOM_STORAGE_KEY = "pdd.settings.thumbnailZoom";
export const DEFAULT_SCAN_FOLDERS: string[] = [];
export const DEFAULT_BACKGROUND_SCAN_INTERVAL_HOURS = 6;
export const DEFAULT_QUICK_SELECT_ENABLED = true;
export const DEFAULT_THUMBNAIL_ZOOM = 1;
export const MIN_THUMBNAIL_ZOOM = 0.5;
export const MAX_THUMBNAIL_ZOOM = 3;
export const BACKGROUND_SCAN_INTERVAL_OPTIONS = [0, 1, 6, 24] as const;

export type Language = "en" | "ko" | "ja";
export type BackgroundScanIntervalHours = typeof BACKGROUND_SCAN_INTERVAL_OPTIONS[number];

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type AddScanFolderResult = {
  folders: string[];
  added: boolean;
  coveredByParent: boolean;
  removedChildCount: number;
};

export function normalizeLanguage(value: string | null | undefined): Language {
  return value === "ko" || value === "ja" ? value : "en";
}

export function loadLanguage(storage = getStorage()): Language {
  if (!storage) return "en";
  return normalizeLanguage(readValue(storage, LANGUAGE_STORAGE_KEY));
}

export function saveLanguage(language: Language, storage = getStorage()) {
  storage?.setItem(LANGUAGE_STORAGE_KEY, language);
}

export function loadScanFolders(storage = getStorage()): string[] {
  if (!storage) return [...DEFAULT_SCAN_FOLDERS];

  try {
    const value = readValue(storage, SCAN_FOLDERS_STORAGE_KEY);
    if (!value) return [...DEFAULT_SCAN_FOLDERS];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [...DEFAULT_SCAN_FOLDERS];
    return normalizeScanFolders(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return [...DEFAULT_SCAN_FOLDERS];
  }
}

export function saveScanFolders(scanFolders: string[], storage = getStorage()) {
  storage?.setItem(SCAN_FOLDERS_STORAGE_KEY, JSON.stringify(normalizeScanFolders(scanFolders)));
  storage?.setItem(SCAN_FOLDERS_UPDATED_AT_STORAGE_KEY, new Date().toISOString());
}

export function loadScanFoldersUpdatedAt(storage = getStorage()): string | null {
  if (!storage) return null;
  return readValue(storage, SCAN_FOLDERS_UPDATED_AT_STORAGE_KEY);
}

export function normalizeBackgroundScanIntervalHours(
  value: string | number | null | undefined
): BackgroundScanIntervalHours {
  const numeric = typeof value === "number" ? value : Number(value);
  return BACKGROUND_SCAN_INTERVAL_OPTIONS.includes(numeric as BackgroundScanIntervalHours)
    ? numeric as BackgroundScanIntervalHours
    : DEFAULT_BACKGROUND_SCAN_INTERVAL_HOURS;
}

export function loadBackgroundScanIntervalHours(storage = getStorage()): BackgroundScanIntervalHours {
  if (!storage) return DEFAULT_BACKGROUND_SCAN_INTERVAL_HOURS;
  return normalizeBackgroundScanIntervalHours(readValue(storage, BACKGROUND_SCAN_INTERVAL_STORAGE_KEY));
}

export function saveBackgroundScanIntervalHours(
  intervalHours: BackgroundScanIntervalHours,
  storage = getStorage()
) {
  storage?.setItem(BACKGROUND_SCAN_INTERVAL_STORAGE_KEY, String(intervalHours));
}

export function loadBackgroundScanLastStartedAt(storage = getStorage()): number | null {
  if (!storage) return null;
  const parsed = Number(readValue(storage, BACKGROUND_SCAN_LAST_STARTED_STORAGE_KEY));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function saveBackgroundScanLastStartedAt(startedAt: number, storage = getStorage()) {
  storage?.setItem(BACKGROUND_SCAN_LAST_STARTED_STORAGE_KEY, String(startedAt));
}

export function loadQuickSelectEnabled(storage = getStorage()): boolean {
  if (!storage) return DEFAULT_QUICK_SELECT_ENABLED;
  const value = readValue(storage, QUICK_SELECT_STORAGE_KEY);
  return value === null ? DEFAULT_QUICK_SELECT_ENABLED : value !== "false";
}

export function saveQuickSelectEnabled(enabled: boolean, storage = getStorage()) {
  storage?.setItem(QUICK_SELECT_STORAGE_KEY, String(enabled));
}

export function normalizeThumbnailZoom(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return DEFAULT_THUMBNAIL_ZOOM;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_THUMBNAIL_ZOOM;
  return Math.min(MAX_THUMBNAIL_ZOOM, Math.max(MIN_THUMBNAIL_ZOOM, numeric));
}

export function loadThumbnailZoom(storage = getStorage()): number {
  if (!storage) return DEFAULT_THUMBNAIL_ZOOM;
  return normalizeThumbnailZoom(readValue(storage, THUMBNAIL_ZOOM_STORAGE_KEY));
}

export function saveThumbnailZoom(zoom: number, storage = getStorage()) {
  storage?.setItem(THUMBNAIL_ZOOM_STORAGE_KEY, String(normalizeThumbnailZoom(zoom)));
}

export function addScanFolder(scanFolders: string[], nextPath: string): string[] {
  return describeAddScanFolder(scanFolders, nextPath).folders;
}

export function describeAddScanFolder(scanFolders: string[], nextPath: string): AddScanFolderResult {
  const before = normalizeScanFolders(scanFolders);
  const next = nextPath.trim();
  const folders = normalizeScanFolders([...before, next]);
  const nextComparable = comparablePath(next);
  const hadEquivalent = before.some((folder) => comparablePath(folder) === nextComparable);
  const added = next.length > 0
    && !hadEquivalent
    && folders.some((folder) => comparablePath(folder) === nextComparable);
  const coveredByParent = next.length > 0
    && !added
    && before.some((folder) => isDescendantPath(next, folder));
  const removedChildCount = added
    ? before.filter((folder) => !folders.some((current) => comparablePath(current) === comparablePath(folder))).length
    : 0;

  return { folders, added, coveredByParent, removedChildCount };
}

export function removeScanFolder(scanFolders: string[], path: string): string[] {
  return scanFolders.filter((folder) => folder !== path);
}

export function normalizeScanFolders(folders: string[]): string[] {
  const candidates = uniqueNonEmpty(folders).map((folder) => ({
    folder,
    comparable: comparablePath(folder),
  }));

  return candidates
    .filter((candidate, index) => (
      candidates.findIndex((item) => item.comparable === candidate.comparable) === index
      && !candidates.some((item, itemIndex) => itemIndex !== index && isDescendantComparablePath(candidate.comparable, item.comparable))
    ))
    .map(({ folder }) => folder);
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const folders: string[] = [];

  for (const value of values) {
    const folder = value.trim();
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }

  return folders;
}

function comparablePath(path: string): string {
  let comparable = path.trim().replace(/\\/g, "/").toLowerCase();
  while (comparable.length > 1 && comparable.endsWith("/")) {
    comparable = comparable.slice(0, -1);
  }
  return comparable;
}

function isDescendantPath(path: string, parent: string): boolean {
  return isDescendantComparablePath(comparablePath(path), comparablePath(parent));
}

function isDescendantComparablePath(path: string, parent: string): boolean {
  return path.length > parent.length
    && path.startsWith(parent)
    && path[parent.length] === "/";
}

function readValue(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function getStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}
