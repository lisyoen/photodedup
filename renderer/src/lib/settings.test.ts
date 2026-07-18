import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCAN_FOLDERS,
  DEFAULT_THUMBNAIL_ZOOM,
  LANGUAGE_STORAGE_KEY,
  SCAN_FOLDERS_STORAGE_KEY,
  THUMBNAIL_ZOOM_STORAGE_KEY,
  addScanFolder,
  loadLanguage,
  loadScanFolders,
  loadThumbnailZoom,
  normalizeScanFolders,
  removeScanFolder,
  saveLanguage,
  saveScanFolders,
  saveThumbnailZoom
} from "./settings";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("settings state", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("defaults language to en when storage is empty", () => {
    expect(loadLanguage(storage)).toBe("en");
  });

  it("defaults scan folders to an empty list when storage is empty", () => {
    expect(loadScanFolders(storage)).toEqual(DEFAULT_SCAN_FOLDERS);
    expect(DEFAULT_SCAN_FOLDERS).toEqual([]);
  });

  it("persists language changes", () => {
    saveLanguage("ja", storage);

    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe("ja");
    expect(loadLanguage(storage)).toBe("ja");
  });

  it("falls back to en for unsupported language values", () => {
    storage.setItem(LANGUAGE_STORAGE_KEY, "fr");

    expect(loadLanguage(storage)).toBe("en");
  });

  it("adds scan folders after trimming input", () => {
    const folders = addScanFolder([], "  D:\\Photos  ");

    expect(folders).toEqual(["D:\\Photos"]);
  });

  it("prevents duplicate and empty scan folders", () => {
    const folders = addScanFolder(addScanFolder(["D:\\Photos"], "D:\\Photos"), " ");

    expect(folders).toEqual(["D:\\Photos"]);
  });

  it("removes scan folders by exact path", () => {
    const folders = removeScanFolder(["D:\\Photos", "E:\\Camera"], "D:\\Photos");

    expect(folders).toEqual(["E:\\Camera"]);
  });

  it("persists scan folders as a JSON array", () => {
    saveScanFolders(["D:\\Photos", "E:\\Camera"], storage);

    expect(storage.getItem(SCAN_FOLDERS_STORAGE_KEY)).toBe("[\"D:\\\\Photos\",\"E:\\\\Camera\"]");
    expect(loadScanFolders(storage)).toEqual(["D:\\Photos", "E:\\Camera"]);
  });

  it("drops child folders when a parent folder is present", () => {
    expect(normalizeScanFolders(["D:\\Photos\\Trips", "D:\\Photos"])).toEqual(["D:\\Photos"]);
  });

  it("detects child folders across case and slash variants", () => {
    expect(normalizeScanFolders(["D:\\PHOTOS", "d:/photos/Trips\\2026"])).toEqual(["D:\\PHOTOS"]);
  });

  it("removes duplicate paths after comparison normalization", () => {
    expect(normalizeScanFolders(["D:\\Photos", "d:/photos/", "E:\\Camera"])).toEqual(["D:\\Photos", "E:\\Camera"]);
  });

  it("keeps unrelated sibling folders", () => {
    expect(normalizeScanFolders(["D:\\Photos\\A", "D:\\Photos\\B"])).toEqual(["D:\\Photos\\A", "D:\\Photos\\B"]);
  });

  it("defaults thumbnail zoom when storage is missing or invalid", () => {
    expect(loadThumbnailZoom(storage)).toBe(DEFAULT_THUMBNAIL_ZOOM);

    storage.setItem(THUMBNAIL_ZOOM_STORAGE_KEY, "not-a-number");
    expect(loadThumbnailZoom(storage)).toBe(DEFAULT_THUMBNAIL_ZOOM);
  });

  it("persists thumbnail zoom with clamping", () => {
    saveThumbnailZoom(1.15, storage);
    expect(storage.getItem(THUMBNAIL_ZOOM_STORAGE_KEY)).toBe("1.15");
    expect(loadThumbnailZoom(storage)).toBe(1.15);

    saveThumbnailZoom(9, storage);
    expect(loadThumbnailZoom(storage)).toBe(3);

    saveThumbnailZoom(0.1, storage);
    expect(loadThumbnailZoom(storage)).toBe(0.5);
  });
});
