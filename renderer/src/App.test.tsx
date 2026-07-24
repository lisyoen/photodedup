import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import App from "./App";
import { HelpView } from "./HelpView";
import { I18nProvider } from "./i18n";
import { HttpDataSource, MockDataSource } from "./lib/api";
import {
  BACKGROUND_SCAN_INTERVAL_STORAGE_KEY,
  BACKGROUND_SCAN_LAST_STARTED_STORAGE_KEY,
  QUICK_SELECT_STORAGE_KEY,
  SCAN_FOLDERS_UPDATED_AT_STORAGE_KEY,
  SCAN_FOLDERS_STORAGE_KEY,
  THUMBNAIL_ZOOM_STORAGE_KEY
} from "./lib/settings";
import type { GroupDetail } from "./types";

const DEFAULT_GROUP_FILTERS = { status: "unresolved", sort: "savings" } as const;

describe("App settings", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    delete window.sidecar;
    delete window.shell;
    setUserAgent(originalUserAgent);
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(HttpDataSource.prototype, "getSettings").mockResolvedValue({
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
      scan_folders: [],
    });
    vi.spyOn(HttpDataSource.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      version: "0.1.0",
      db_path: "C:\\Data\\manifest.db",
      thumbs_dir: "C:\\Data\\thumbs",
      images: 0,
      groups: 0,
    });
    vi.spyOn(MockDataSource.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      version: "mock",
      db_path: "mock://manifest.db",
      thumbs_dir: "mock://thumbs",
      images: 0,
      groups: 0,
    });
    vi.spyOn(HttpDataSource.prototype, "loadGroupSnapshot").mockResolvedValue(null);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders an engine error instead of mock data inside Electron without sidecar", async () => {
    setUserAgent("Mozilla/5.0 Electron/33.2.1");
    const listGroupDetails = vi.spyOn(MockDataSource.prototype, "listGroupDetails");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await settle();

    expect(document.body.textContent).toContain("Engine connection failed. Quit the app and start it again.");
    expect(document.body.textContent).not.toContain("Preview mode - mock data");
    expect(listGroupDetails).not.toHaveBeenCalled();
  });

  it("renders mock data with a fixed preview banner outside Electron without sidecar", async () => {
    const listGroupDetails = vi.spyOn(MockDataSource.prototype, "listGroupDetails");
    saveStoredScanFolders(["D:\\Preview Photos"]);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => listGroupDetails.mock.calls.length > 0);

    expect(document.body.textContent).toContain("Preview mode - mock data (not real photos or file names)");
    expect(document.querySelector(".preview-banner")).toBeTruthy();
  });

  it("uses HttpDataSource without a preview banner when sidecar exists", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["D:\\Live Photos"]);
    const listGroupDetails = vi.spyOn(HttpDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(HttpDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "live-scan",
      status: "queued",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => listGroupDetails.mock.calls.length > 0);

    expect(listGroupDetails).toHaveBeenCalledWith(["D:\\Live Photos"], DEFAULT_GROUP_FILTERS);
    expect(document.body.textContent).not.toContain("Preview mode - mock data");
    expect(document.querySelector(".preview-banner")).toBeNull();
  });

  it("does not auto-scan on startup when manifest data exists with no unresolved groups", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["D:\\Resolved Photos"]);
    vi.spyOn(HttpDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    const getHealth = vi.spyOn(HttpDataSource.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      version: "0.1.0",
      db_path: "C:\\Data\\manifest.db",
      thumbs_dir: "C:\\Data\\thumbs",
      images: 24,
      groups: 12,
    });
    const startScan = vi.spyOn(HttpDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "unexpected-scan",
      status: "queued",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => getHealth.mock.calls.length === 1);
    await settle();

    expect(startScan).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("No unresolved groups.");
  });

  it("auto-scans once on startup when the engine has no images and scan folders exist", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["D:\\Empty Engine"]);
    vi.spyOn(HttpDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(HttpDataSource.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      version: "0.1.0",
      db_path: "C:\\Data\\manifest.db",
      thumbs_dir: "C:\\Data\\thumbs",
      images: 0,
      groups: 0,
    });
    const startScan = vi.spyOn(HttpDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "startup-scan",
      status: "queued",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => startScan.mock.calls.length === 1);

    expect(startScan).toHaveBeenCalledWith({ roots: ["D:\\Empty Engine"] });
  });

  it("passes status filter changes to group loading", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["D:\\Live Photos"]);
    const processed = scanFolderGroupDetail("D:\\Live Photos");
    processed.group.id = 202;
    const listGroupDetails = vi.spyOn(HttpDataSource.prototype, "listGroupDetails")
      .mockResolvedValueOnce({ items: [], next_cursor: null, total_estimate: 0 })
      .mockResolvedValueOnce({ items: [processed], next_cursor: null, total_estimate: 1 });
    vi.spyOn(HttpDataSource.prototype, "getGroup").mockResolvedValue(processed);
    vi.spyOn(HttpDataSource.prototype, "startScan").mockResolvedValue({ scan_id: "status-scan", status: "queued" });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => listGroupDetails.mock.calls.length > 0);
    selectOption(getSelectByLabel("Status"), "processed");

    await waitUntil(() => listGroupDetails.mock.calls.length === 2);
    expect(listGroupDetails).toHaveBeenLastCalledWith(["D:\\Live Photos"], { status: "processed", sort: "savings" });
    await waitUntil(() => document.body.textContent?.includes("#202") === true);
    expect(document.body.textContent).toContain("#202");
  });

  it("passes all status filter changes to group loading", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["D:\\Live Photos"]);
    const listGroupDetails = vi.spyOn(HttpDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(HttpDataSource.prototype, "startScan").mockResolvedValue({ scan_id: "all-scan", status: "queued" });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => listGroupDetails.mock.calls.length > 0);
    selectOption(getSelectByLabel("Status"), "all");

    await waitUntil(() => listGroupDetails.mock.calls.some((call) => call[1]?.status === "all"));
    expect(listGroupDetails).toHaveBeenLastCalledWith(["D:\\Live Photos"], { status: "all", sort: "savings" });
  });

  it("passes sort filter changes to group loading", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["D:\\Live Photos"]);
    const listGroupDetails = vi.spyOn(HttpDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(HttpDataSource.prototype, "startScan").mockResolvedValue({ scan_id: "sort-scan", status: "queued" });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => listGroupDetails.mock.calls.length > 0);
    selectOption(getSelectByLabel("Sort"), "similarity");

    await waitUntil(() => listGroupDetails.mock.calls.some((call) => call[1]?.sort === "similarity"));
    expect(listGroupDetails).toHaveBeenLastCalledWith(["D:\\Live Photos"], { status: "unresolved", sort: "similarity" });
  });

  it("waits for settings before loading groups with persisted scan folders", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["C:\\Stale Local"], "2026-07-12T00:00:00.000Z");
    let resolveSettings: (settings: Awaited<ReturnType<HttpDataSource["getSettings"]>>) => void = () => undefined;
    vi.spyOn(HttpDataSource.prototype, "getSettings").mockReturnValue(new Promise((resolve) => {
      resolveSettings = resolve;
    }));
    const listGroupDetails = vi.spyOn(HttpDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(HttpDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "settings-ordered-scan",
      status: "queued",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    expect(listGroupDetails).not.toHaveBeenCalled();

    resolveSettings({
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
      scan_folders: ["D:\\Engine Truth"],
      scan_folders_updated_at: "2026-07-13T00:00:00.000Z",
    });

    await waitUntil(() => listGroupDetails.mock.calls.length > 0);
    expect(listGroupDetails).toHaveBeenCalledWith(["D:\\Engine Truth"], DEFAULT_GROUP_FILTERS);
  });

  it("polls cleanup completion and reloads groups after apply confirmation", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["D:\\Apply Photos"]);
    const detail = applyGroupDetail();
    const listGroupDetails = vi.spyOn(HttpDataSource.prototype, "listGroupDetails")
      .mockResolvedValueOnce({
        items: [detail],
        next_cursor: null,
        total_estimate: 1,
      })
      .mockResolvedValueOnce({
        items: [],
        next_cursor: null,
        total_estimate: 0,
      });
    vi.spyOn(HttpDataSource.prototype, "getGroup").mockResolvedValue(detail);
    const applyMarkedDeletes = vi.spyOn(HttpDataSource.prototype, "applyMarkedDeletes").mockResolvedValue({
      job_id: "cleanup-1",
      status: "queued",
      targets: 1,
    });
    const getCleanup = vi.spyOn(HttpDataSource.prototype, "getCleanup").mockResolvedValue({
      id: "cleanup-1",
      kind: "cleanup",
      status: "done",
      phase: "done",
      done: 1,
      total: 1,
      summary: { deleted: 1, failed: 0 },
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("#101") === true);
    getRequiredElement(".apply-button").click();
    await settle();
    getButton("Apply all").click();

    await waitUntil(() =>
      listGroupDetails.mock.calls.length === 2 &&
      document.querySelector(".modal-backdrop") === null &&
      document.body.textContent?.includes("No groups loaded.") === true
    );

    expect(applyMarkedDeletes).toHaveBeenCalledWith("trash", [101]);
    expect(getCleanup).toHaveBeenCalledWith("cleanup-1");
    expect(listGroupDetails).toHaveBeenLastCalledWith(["D:\\Apply Photos"], DEFAULT_GROUP_FILTERS);
    expect(document.body.textContent).toContain("No groups loaded.");
  });

  it("shows a no-target toast when apply completes with zero processed items", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["D:\\Apply Photos"]);
    const detail = applyGroupDetail();
    vi.spyOn(HttpDataSource.prototype, "listGroupDetails")
      .mockResolvedValueOnce({
        items: [detail],
        next_cursor: null,
        total_estimate: 1,
      })
      .mockResolvedValueOnce({
        items: [],
        next_cursor: null,
        total_estimate: 0,
      });
    vi.spyOn(HttpDataSource.prototype, "getGroup").mockResolvedValue(detail);
    vi.spyOn(HttpDataSource.prototype, "applyMarkedDeletes").mockResolvedValue({
      job_id: "cleanup-0",
      status: "queued",
      targets: 0,
    });
    vi.spyOn(HttpDataSource.prototype, "getCleanup").mockResolvedValue({
      id: "cleanup-0",
      kind: "cleanup",
      status: "done",
      phase: "done",
      done: 0,
      total: 0,
      summary: { deleted: 0, failed: 0 },
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("#101") === true);
    getRequiredElement(".apply-button").click();
    await settle();
    getButton("Apply all").click();

    await waitUntil(() => document.body.textContent?.includes("There are no items to process.") === true);
    expect(document.body.textContent).not.toContain("0 deleted, 0 failed");
  });

  it("keeps language choices in native labels across UI languages", async () => {
    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await settle();

    getButton("Open settings").click();
    await settle();
    expectLanguageLabels("English (default)");

    getInputByLabel("한국어").click();
    await settle();
    expectLanguageLabels("English (기본값)");

    getInputByLabel("日本語").click();
    await settle();
    expectLanguageLabels("English (既定)");
  });

  it("renders settings modal with a dedicated scrollable body between title and actions", async () => {
    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await settle();

    getButton("Open settings").click();
    await settle();

    const modal = getRequiredElement(".settings-modal");
    const children = Array.from(modal.children);

    expect(children[0]).toBe(document.querySelector("#settings-title"));
    expect(children[1]).toBe(document.querySelector(".settings-modal > .modal-body"));
    expect(children[2]).toBe(document.querySelector(".settings-modal > .modal-actions"));
    expect(children[1]?.querySelector(".settings-section")).toBeTruthy();
    expect(children[1]?.querySelector(".modal-actions")).toBeNull();
  });

  it("shows an empty scan folder list before settings are saved", async () => {
    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await settle();

    getButton("Open settings").click();
    await settle();

    expect(document.body.textContent).toContain("No scan folders added yet.");
    expect(document.body.textContent).toContain("Add a scan folder");
  });

  it("uses saved scan folders for the scan header and group filter on mount", async () => {
    const listGroupDetails = vi.spyOn(MockDataSource.prototype, "listGroupDetails");
    saveStoredScanFolders(["D:\\Settings Photos", "E:\\Camera Roll"]);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => listGroupDetails.mock.calls.length > 0);
    await waitUntil(() => document.body.textContent?.includes("D:\\Settings Photos") === true);

    expect(listGroupDetails).toHaveBeenCalledWith(["D:\\Settings Photos", "E:\\Camera Roll"], DEFAULT_GROUP_FILTERS);
    expect(document.body.textContent).toContain("D:\\Settings Photos + 1 more");
  });

  it("clears groups immediately when the last scan folder is removed in settings", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["D:\\Only Root"]);
    const detail = scanFolderGroupDetail("D:\\Only Root");
    const listGroupDetails = vi.spyOn(HttpDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [detail],
      next_cursor: null,
      total_estimate: 1,
    });
    vi.spyOn(HttpDataSource.prototype, "getGroup").mockResolvedValue(detail);
    const putSettings = vi.spyOn(HttpDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #501") === true);
    getButton("Open settings").click();
    await settle();
    getButton("Remove D:\\Only Root").click();

    await waitUntil(() => document.body.textContent?.includes("Group #501") === false);

    expect(document.body.textContent).toContain("Add a scan folder");
    expect(putSettings).toHaveBeenLastCalledWith(expect.objectContaining({ scan_folders: [] }));
    expect(listGroupDetails.mock.calls.every(([roots]) => Array.isArray(roots))).toBe(true);
  });

  it("saves similarity threshold and starts a rescan for saved folders", async () => {
    saveStoredScanFolders(["D:\\Threshold Photos", "E:\\Camera Roll"]);
    vi.spyOn(MockDataSource.prototype, "getSettings").mockResolvedValue({
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
    });
    const putSettings = vi.spyOn(MockDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);
    const startScan = vi.spyOn(MockDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "threshold-rescan",
      status: "queued",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    getButton("Open settings").click();
    await waitUntil(() => document.querySelector('input[type="range"][aria-label="Similarity threshold"]') !== null);
    await waitUntil(() => getRange("Similarity threshold").value === "90");

    const slider = getRange("Similarity threshold");
    setInputValue(slider, "95");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    await waitUntil(() => !getButton("Save settings").disabled);
    getButton("Save settings").click();

    await waitUntil(() =>
      putSettings.mock.calls.length > 0 &&
      startScan.mock.calls.length > 0 &&
      document.querySelector(".settings-modal") === null &&
      document.body.textContent?.includes("Similarity threshold saved. Rescan started.") === true
    );

    expect(putSettings).toHaveBeenCalledWith({
      threshold: 95,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
      scan_folders: ["D:\\Threshold Photos", "E:\\Camera Roll"],
      scan_folders_updated_at: expect.any(String),
      include_online_only: false,
    });
    expect(startScan).toHaveBeenCalledWith({ roots: ["D:\\Threshold Photos", "E:\\Camera Roll"] });
    expect(document.body.textContent).toContain("Similarity threshold saved. Rescan started.");
    expect(document.querySelector(".settings-modal")).toBeNull();
  });

  it("promotes newer stored scan folders over stale engine settings on startup", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    saveStoredScanFolders(["C:\\Users\\lisyo\\OneDrive\\Pictures\\도아"], "2026-07-14T01:00:00.000Z");
    vi.spyOn(HttpDataSource.prototype, "getSettings").mockResolvedValue({
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
      scan_folders: ["D:\\Old Photos"],
      scan_folders_updated_at: "2026-07-13T01:00:00.000Z",
    });
    const putSettings = vi.spyOn(HttpDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);
    const listGroupDetails = vi.spyOn(HttpDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(HttpDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "unicode-startup-scan",
      status: "queued",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => listGroupDetails.mock.calls.length > 0);

    expect(listGroupDetails).toHaveBeenCalledWith(["C:\\Users\\lisyo\\OneDrive\\Pictures\\도아"], DEFAULT_GROUP_FILTERS);
    expect(putSettings).toHaveBeenCalledWith(expect.objectContaining({
      scan_folders: ["C:\\Users\\lisyo\\OneDrive\\Pictures\\도아"],
    }));
  });

  it("persists settings folder changes to the engine before the next save click", async () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    vi.spyOn(HttpDataSource.prototype, "getSettings").mockResolvedValue({
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
      scan_folders: ["D:\\Old Photos"],
      scan_folders_updated_at: "2026-07-13T01:00:00.000Z",
    });
    vi.spyOn(HttpDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    const putSettings = vi.spyOn(HttpDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);
    vi.spyOn(HttpDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "settings-folder-sync",
      status: "queued",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("D:\\Old Photos") === true);
    getButton("Open settings").click();
    await waitUntil(() => document.querySelector(".settings-modal") !== null);
    const folderInput = getAriaInput("Folder path");
    setInputValue(folderInput, "C:\\Users\\lisyo\\OneDrive\\Pictures\\도아");
    folderInput.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    getButton("Add").click();

    await waitUntil(() => putSettings.mock.calls.length > 0);

    expect(putSettings).toHaveBeenCalledWith(expect.objectContaining({
      scan_folders: ["D:\\Old Photos", "C:\\Users\\lisyo\\OneDrive\\Pictures\\도아"],
    }));
  });

  it("starts a periodic background scan when the interval is due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    saveStoredScanFolders(["D:\\Periodic Photos"]);
    saveStoredBackgroundScanInterval("1");
    saveStoredBackgroundScanLastStartedAt(Date.now());
    const detail = applyGroupDetail();
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [detail],
      next_cursor: null,
      total_estimate: 1,
    });
    vi.spyOn(MockDataSource.prototype, "getGroup").mockResolvedValue(detail);
    const startScan = vi.spyOn(MockDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "periodic-scan",
      status: "queued",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntilFake(() => document.body.textContent?.includes("#101") === true);
    expect(startScan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    await flushPromises();
    expect(startScan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await waitUntilFake(() => startScan.mock.calls.length === 1);

    expect(startScan).toHaveBeenCalledWith({ roots: ["D:\\Periodic Photos"] });
  });

  it("skips a periodic background scan while another scan is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    saveStoredScanFolders(["D:\\Running Periodic Photos"]);
    saveStoredBackgroundScanInterval("1");
    saveStoredBackgroundScanLastStartedAt(Date.now());
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    const startScan = vi.spyOn(MockDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "active-scan",
      status: "queued",
    });
    vi.spyOn(MockDataSource.prototype, "getScan").mockResolvedValue({
      scan_id: "active-scan",
      status: "running",
      phase: "scanning",
      done: 1,
      total: 10,
      cancellable: true,
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntilFake(() => startScan.mock.calls.length === 1);
    await waitUntilFake(() => document.body.textContent?.includes("running") === true);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await flushPromises();
    flushSync(() => undefined);

    expect(startScan).toHaveBeenCalledTimes(1);
  });

  it("does not start a periodic background scan when the interval is off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    saveStoredScanFolders(["D:\\Off Periodic Photos"]);
    saveStoredBackgroundScanInterval("0");
    saveStoredBackgroundScanLastStartedAt(Date.now() - 24 * 60 * 60 * 1000);
    const detail = applyGroupDetail();
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [detail],
      next_cursor: null,
      total_estimate: 1,
    });
    vi.spyOn(MockDataSource.prototype, "getGroup").mockResolvedValue(detail);
    const startScan = vi.spyOn(MockDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "off-periodic-scan",
      status: "queued",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntilFake(() => document.body.textContent?.includes("#101") === true);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await flushPromises();

    expect(startScan).not.toHaveBeenCalled();
  });

  it("keeps the settings save button enabled while a scan is running", async () => {
    saveStoredScanFolders(["D:\\Running Photos"]);
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(MockDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "active-scan",
      status: "queued",
    });
    vi.spyOn(MockDataSource.prototype, "getScan").mockResolvedValue({
      scan_id: "active-scan",
      status: "running",
      phase: "scanning",
      done: 1,
      total: 10,
      cancellable: true,
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("running") === true);
    getButton("Open settings").click();
    await waitUntil(() => document.body.textContent?.includes("Similarity threshold") === true);

    expect(getButton("Save settings").disabled).toBe(false);
  });

  it("starts a manual scan from the scan panel when idle", async () => {
    saveStoredScanFolders(["D:\\Manual Photos"]);
    const detail = applyGroupDetail();
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [detail],
      next_cursor: null,
      total_estimate: 1,
    });
    vi.spyOn(MockDataSource.prototype, "getGroup").mockResolvedValue(detail);
    const startScan = vi.spyOn(MockDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "manual-scan",
      status: "queued",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("#101") === true);
    getButton("Start scan").click();

    await waitUntil(() => startScan.mock.calls.length === 1);

    expect(startScan).toHaveBeenCalledWith({ roots: ["D:\\Manual Photos"] });
  });

  it("cancels a running scan and shows the start button again", async () => {
    saveStoredScanFolders(["D:\\Cancel Photos"]);
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(MockDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "active-scan",
      status: "queued",
    });
    const getScan = vi.spyOn(MockDataSource.prototype, "getScan")
      .mockResolvedValueOnce({
        scan_id: "active-scan",
        status: "running",
        phase: "scanning",
        done: 1,
        total: 10,
        cancellable: true,
      })
      .mockResolvedValueOnce({
        scan_id: "active-scan",
        status: "cancelled",
        phase: "done",
        done: 1,
        total: 10,
        cancellable: false,
      });
    const cancelScan = vi.spyOn(MockDataSource.prototype, "cancelScan").mockResolvedValue({
      scan_id: "active-scan",
      status: "cancelled",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("running") === true);
    getButton("Cancel scan").click();

    await waitUntil(() => cancelScan.mock.calls.length === 1 && document.body.textContent?.includes("Start scan") === true);

    expect(cancelScan).toHaveBeenCalledWith("active-scan");
    expect(getScan).toHaveBeenCalledWith("active-scan");
  });

  it("renders collecting phase without a 0/0 count", async () => {
    saveStoredScanFolders(["D:\\Collect Photos"]);
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(MockDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "collecting-scan",
      status: "queued",
    });
    vi.spyOn(MockDataSource.prototype, "getScan").mockResolvedValue({
      scan_id: "collecting-scan",
      status: "running",
      phase: "collecting",
      done: 500,
      total: 0,
      cancellable: true,
      skipped: { cloud_placeholders: 2, reparse_dirs: 1, unreadable: 0 },
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes(
      "Collecting files · 500 found · 2 online-only files excluded (not downloaded from cloud) · 1 reparse directories excluded"
    ) === true);

    expect(document.body.textContent).not.toContain("0/0");
  });

  it("renders scan cache stats and grouping skipped completion summary", async () => {
    vi.useFakeTimers();
    saveStoredScanFolders(["D:\\Cached Photos"]);
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(MockDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "cached-scan",
      status: "queued",
    });
    vi.spyOn(MockDataSource.prototype, "getScan")
      .mockResolvedValueOnce({
        scan_id: "cached-scan",
        status: "running",
        phase: "scanning",
        done: 8,
        total: 10,
        cancellable: true,
        cache_hits: 6,
        analyzed_new: 2,
      })
      .mockResolvedValue({
        scan_id: "cached-scan",
        status: "done",
        phase: "done",
        done: 10,
        total: 10,
        cancellable: false,
        summary: {
          cache_hits: 10,
          analyzed_new: 0,
          grouping_skipped: true,
        },
      });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntilFake(() => document.body.textContent?.includes("cache 6 · new analysis 2") === true);
    await vi.advanceTimersByTimeAsync(1000);
    await waitUntilFake(() => document.body.textContent?.includes("No new files - groups kept") === true);

    expect(document.body.textContent).toContain("cache 10 · new analysis 0");
  });

  it("disables manual scan start when no scan folder is configured", async () => {
    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();

    expect(getButton("Start scan").disabled).toBe(true);
  });

  it("cancels the running scan before starting a threshold rescan", async () => {
    saveStoredScanFolders(["D:\\Running Photos", "E:\\Camera Roll"]);
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(MockDataSource.prototype, "getSettings").mockResolvedValue({
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
    });
    const putSettings = vi.spyOn(MockDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);
    const startScan = vi.spyOn(MockDataSource.prototype, "startScan")
      .mockResolvedValueOnce({
        scan_id: "active-scan",
        status: "queued",
      })
      .mockResolvedValueOnce({
        scan_id: "threshold-rescan",
        status: "queued",
      });
    vi.spyOn(MockDataSource.prototype, "getScan").mockResolvedValue({
      scan_id: "active-scan",
      status: "running",
      phase: "scanning",
      done: 1,
      total: 10,
      cancellable: true,
    });
    const cancelScan = vi.spyOn(MockDataSource.prototype, "cancelScan").mockResolvedValue({
      scan_id: "active-scan",
      status: "cancelled",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => startScan.mock.calls.length === 1);
    await waitUntil(() => document.body.textContent?.includes("running") === true);
    await waitUntil(() => document.body.textContent?.includes("Cancel scan") === true);
    getButton("Open settings").click();
    await waitUntil(() => document.querySelector('input[type="range"][aria-label="Similarity threshold"]') !== null);
    await waitUntil(() => getRange("Similarity threshold").value === "90");

    const slider = getRange("Similarity threshold");
    setInputValue(slider, "94");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    await waitUntil(() => getRange("Similarity threshold").value === "94" && !getButton("Save settings").disabled);
    getButton("Save settings").click();

    await waitUntil(() =>
      putSettings.mock.calls.length > 0 &&
      cancelScan.mock.calls.length > 0 &&
      startScan.mock.calls.length === 2 &&
      document.querySelector(".settings-modal") === null &&
      document.body.textContent?.includes("Similarity threshold saved. Rescan started.") === true
    );

    expect(cancelScan).toHaveBeenCalledWith("active-scan");
    expect(startScan).toHaveBeenLastCalledWith({ roots: ["D:\\Running Photos", "E:\\Camera Roll"] });
    expect(cancelScan.mock.invocationCallOrder[0]).toBeLessThan(startScan.mock.invocationCallOrder[1]);
    expect(document.body.textContent).toContain("Similarity threshold saved. Rescan started.");
    expect(document.querySelector(".settings-modal")).toBeNull();
  });

  it("rescans with reset progress after scan folders change in settings", async () => {
    saveStoredScanFolders(["D:\\Running Photos"]);
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(MockDataSource.prototype, "getSettings").mockResolvedValue({
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
    });
    const putSettings = vi.spyOn(MockDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);
    const startScan = vi.spyOn(MockDataSource.prototype, "startScan")
      .mockResolvedValueOnce({
        scan_id: "active-scan",
        status: "queued",
      })
      .mockResolvedValueOnce({
        scan_id: "folder-rescan",
        status: "queued",
      });
    vi.spyOn(MockDataSource.prototype, "getScan").mockResolvedValue({
      scan_id: "active-scan",
      status: "running",
      phase: "scanning",
      done: 1,
      total: 10,
      cancellable: true,
    });
    const cancelScan = vi.spyOn(MockDataSource.prototype, "cancelScan").mockResolvedValue({
      scan_id: "active-scan",
      status: "cancelled",
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => startScan.mock.calls.length === 1);
    await waitUntil(() => document.body.textContent?.includes("scanning · 1/10 · running") === true);
    getButton("Open settings").click();
    await waitUntil(() => document.querySelector(".settings-modal") !== null);
    const folderInput = getAriaInput("Folder path");
    setInputValue(folderInput, "E:\\Camera Roll");
    folderInput.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    getButton("Add").click();
    await waitUntil(() =>
      putSettings.mock.calls.some(([settings]) =>
        settings.scan_folders?.length === 2 &&
        settings.scan_folders.includes("E:\\Camera Roll")
      ) &&
      document.body.textContent?.includes("E:\\Camera Roll") === true
    );
    getButton("Save settings").click();

    await waitUntil(() =>
      cancelScan.mock.calls.length === 1 &&
      startScan.mock.calls.length === 2 &&
      document.body.textContent?.includes("Collecting files · 0 found · queued") === true &&
      document.body.textContent.includes("1/10") === false
    );

    expect(cancelScan).toHaveBeenCalledWith("active-scan");
    expect(startScan).toHaveBeenLastCalledWith({ roots: ["D:\\Running Photos", "E:\\Camera Roll"] });
    expect(document.body.textContent).toContain("Collecting files · 0 found · queued");
    expect(document.body.textContent).not.toContain("1/10");
  });

  it("renders cancel_requested as a localized status label", async () => {
    saveStoredScanFolders(["D:\\Cancel Requested Photos"]);
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    });
    vi.spyOn(MockDataSource.prototype, "startScan").mockResolvedValue({
      scan_id: "cancel-requested-scan",
      status: "queued",
    });
    vi.spyOn(MockDataSource.prototype, "getScan").mockResolvedValue({
      scan_id: "cancel-requested-scan",
      status: "cancel_requested",
      phase: "scanning",
      done: 4,
      total: 20,
      cancellable: false,
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Cancelling...") === true);

    expect(document.body.textContent).toContain("scanning · 4/20 · Cancelling...");
    expect(document.body.textContent).not.toContain("cancel_requested");
  });

  it("adds folders from the native settings folder picker when the bridge exists", async () => {
    window.shell = {
      selectFolder: vi.fn(),
      selectFolders: vi.fn().mockResolvedValue(["D:\\Picker Photos", "D:\\Picker Photos\\Child"]),
      onTrayScanNow: vi.fn(() => () => undefined),
    };

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    getButton("Open settings").click();
    await waitUntil(() => document.querySelector(".settings-modal") !== null);
    getButton("Select folders").click();

    await waitUntil(() => document.body.textContent?.includes("D:\\Picker Photos") === true);

    expect(window.shell.selectFolders).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("D:\\Picker Photos");
    expect(document.body.textContent).not.toContain("D:\\Picker Photos\\Child");
  });

  it("hides the settings folder picker when the bridge is unavailable", async () => {
    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    getButton("Open settings").click();
    await waitUntil(() => document.querySelector(".settings-modal") !== null);

    expect(Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Select folders")).toBe(false);
  });

  it("shows the current app version in the header", async () => {
    const getAppVersion = vi.fn().mockResolvedValue("0.1.2");
    window.shell = {
      selectFolder: vi.fn(),
      selectFolders: vi.fn(),
      getAppVersion,
      getUpdateAvailability: vi.fn().mockResolvedValue(null),
      onTrayScanNow: vi.fn(() => () => undefined),
    };

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => getAppVersion.mock.calls.length === 1);
    await waitUntil(() => document.querySelector(".topbar .version-badge")?.textContent?.trim() === "v0.1.2");

    expect(document.querySelector(".topbar .version-badge")?.textContent?.trim()).toBe("v0.1.2");
  });

  it("shows an emphasized update badge and opens the existing update modal on click", async () => {
    const getAppVersion = vi.fn().mockResolvedValue("0.1.2");
    window.shell = {
      selectFolder: vi.fn(),
      selectFolders: vi.fn(),
      getAppVersion,
      getUpdateAvailability: vi.fn().mockResolvedValue({
        latest: "0.1.3",
        current: "0.1.2",
        htmlUrl: "https://github.com/lisyoen/photodedup/releases/tag/v0.1.3",
        updateAvailable: true,
        isSourceInstall: true,
      }),
      onTrayScanNow: vi.fn(() => () => undefined),
      onUpdateAvailable: vi.fn(() => () => undefined),
      onUpdateProgress: vi.fn(() => () => undefined),
    };

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("New version v0.1.3 is available") === true);
    getButton("Later").click();
    await waitUntil(() => document.querySelector(".update-modal") === null);
    const badge = getRequiredElement(".topbar .version-badge");

    expect(badge.classList.contains("available")).toBe(true);
    expect(badge.textContent?.trim()).toBe("v0.1.2 -> v0.1.3 update");

    badge.click();

    await waitUntil(() => document.body.textContent?.includes("New version v0.1.3 is available") === true);
  });

  it("shows a muted latest-version badge and does not open the update modal on click", async () => {
    window.shell = {
      selectFolder: vi.fn(),
      selectFolders: vi.fn(),
      getAppVersion: vi.fn().mockResolvedValue("0.1.2"),
      getUpdateAvailability: vi.fn().mockResolvedValue({
        current: "0.1.2",
        latest: "0.1.2",
        htmlUrl: "https://github.com/lisyoen/photodedup/releases/tag/v0.1.2",
        updateAvailable: false,
        isSourceInstall: true,
      }),
      onTrayScanNow: vi.fn(() => () => undefined),
      onUpdateAvailable: vi.fn(() => () => undefined),
      onUpdateProgress: vi.fn(() => () => undefined),
    };

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.querySelector(".topbar .version-badge")?.textContent?.trim() === "v0.1.2 · latest v0.1.2");
    const badge = getRequiredElement(".topbar .version-badge");

    expect(badge.classList.contains("current")).toBe(true);
    expect(badge.getAttribute("title")).toBe("You are on the latest version");

    badge.click();
    await settle();

    expect(document.querySelector(".update-modal")).toBeNull();
  });

  it("shows only the current version when the latest-version check fails", async () => {
    window.shell = {
      selectFolder: vi.fn(),
      selectFolders: vi.fn(),
      getAppVersion: vi.fn().mockResolvedValue("0.1.2"),
      getUpdateAvailability: vi.fn().mockResolvedValue({
        current: "0.1.2",
        latest: null,
        htmlUrl: null,
        updateAvailable: false,
        isSourceInstall: true,
      }),
      onTrayScanNow: vi.fn(() => () => undefined),
      onUpdateAvailable: vi.fn(() => () => undefined),
      onUpdateProgress: vi.fn(() => () => undefined),
    };

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.querySelector(".topbar .version-badge")?.textContent?.trim() === "v0.1.2");
    const badge = getRequiredElement(".topbar .version-badge");

    expect(badge.classList.contains("current")).toBe(true);
    expect(badge.getAttribute("title")).toBe("Failed to check latest version");

    badge.click();
    await settle();

    expect(document.querySelector(".update-modal")).toBeNull();
  });

  it("updates the version badge from the update availability event after an empty mount lookup", async () => {
    const updateAvailableCallbacks: Array<(update: {
      latest: string | null;
      current: string;
      htmlUrl: string | null;
      updateAvailable: boolean;
      isSourceInstall: boolean;
    }) => void> = [];
    window.shell = {
      selectFolder: vi.fn(),
      selectFolders: vi.fn(),
      getAppVersion: vi.fn().mockResolvedValue("0.1.2"),
      getUpdateAvailability: vi.fn().mockResolvedValue(null),
      onTrayScanNow: vi.fn(() => () => undefined),
      onUpdateAvailable: vi.fn((callback) => {
        updateAvailableCallbacks.push(callback);
        return () => undefined;
      }),
      onUpdateProgress: vi.fn(() => () => undefined),
    };

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.querySelector(".topbar .version-badge")?.textContent?.trim() === "v0.1.2");
    updateAvailableCallbacks[0]({
      latest: "0.1.3",
      current: "0.1.2",
      htmlUrl: "https://github.com/lisyoen/photodedup/releases/tag/v0.1.3",
      updateAvailable: true,
      isSourceInstall: true,
    });

    await waitUntil(() => document.querySelector(".topbar .version-badge")?.textContent?.trim() === "v0.1.2 -> v0.1.3 update");
    expect(getRequiredElement(".topbar .version-badge").classList.contains("available")).toBe(true);
  });

  it("renders the source update modal and starts the update", async () => {
    const updateAvailableCallbacks: Array<(update: {
      latest: string | null;
      current: string;
      htmlUrl: string | null;
      updateAvailable: boolean;
      isSourceInstall: boolean;
    }) => void> = [];
    const startUpdate = vi.fn().mockResolvedValue({ ok: true });
    window.shell = {
      selectFolder: vi.fn(),
      selectFolders: vi.fn(),
      startUpdate,
      onTrayScanNow: vi.fn(() => () => undefined),
      onUpdateAvailable: vi.fn((callback) => {
        updateAvailableCallbacks.push(callback);
        return () => undefined;
      }),
      onUpdateProgress: vi.fn(() => () => undefined),
    };

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => updateAvailableCallbacks.length === 1);
    updateAvailableCallbacks[0]({
      latest: "0.2.0",
      current: "0.1.2",
      htmlUrl: "https://github.com/lisyoen/photodedup/releases/tag/v0.2.0",
      updateAvailable: true,
      isSourceInstall: true,
    });
    await waitUntil(() => document.body.textContent?.includes("New version v0.2.0 is available") === true);

    expect(document.body.textContent).toContain("current v0.1.2");
    expect(document.body.textContent).toContain("Release notes");
    getButton("Update").click();

    await waitUntil(() => startUpdate.mock.calls.length === 1);
    expect(startUpdate).toHaveBeenCalledTimes(1);
  });

  it("opens the release page for packaged installs and suppresses later reminders in the session", async () => {
    const updateAvailableCallbacks: Array<(update: {
      latest: string | null;
      current: string;
      htmlUrl: string | null;
      updateAvailable: boolean;
      isSourceInstall: boolean;
    }) => void> = [];
    const openReleasePage = vi.fn().mockResolvedValue(undefined);
    window.shell = {
      selectFolder: vi.fn(),
      selectFolders: vi.fn(),
      openReleasePage,
      onTrayScanNow: vi.fn(() => () => undefined),
      onUpdateAvailable: vi.fn((callback) => {
        updateAvailableCallbacks.push(callback);
        return () => undefined;
      }),
      onUpdateProgress: vi.fn(() => () => undefined),
    };

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => updateAvailableCallbacks.length === 1);
    const update = {
      latest: "0.2.0",
      current: "0.1.2",
      htmlUrl: "https://github.com/lisyoen/photodedup/releases/tag/v0.2.0",
      updateAvailable: true,
      isSourceInstall: false,
    };
    updateAvailableCallbacks[0](update);
    await waitUntil(() => document.body.textContent?.includes("Open release page") === true);
    getButton("Later").click();
    await settle();
    updateAvailableCallbacks[0](update);
    await settle();

    expect(document.body.textContent).not.toContain("Open release page");
    expect(openReleasePage).not.toHaveBeenCalled();
  });

  it("checks every 60 seconds and announces a newly detected version only once", async () => {
    vi.useFakeTimers();
    const update = {
      latest: "0.1.6",
      current: "0.1.5",
      htmlUrl: "https://github.com/lisyoen/photodedup/releases/tag/v0.1.6",
      updateAvailable: true,
      isSourceInstall: true,
    };
    const checkForUpdates = vi.fn().mockResolvedValue(update);
    window.shell = {
      selectFolder: vi.fn(),
      selectFolders: vi.fn(),
      getAppVersion: vi.fn().mockResolvedValue("0.1.5"),
      getUpdateAvailability: vi.fn().mockResolvedValue(null),
      checkForUpdates,
      onTrayScanNow: vi.fn(() => () => undefined),
      onUpdateAvailable: vi.fn(() => () => undefined),
      onUpdateProgress: vi.fn(() => () => undefined),
    };

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await waitUntilFake(() => document.querySelector(".topbar .version-badge") !== null);

    await vi.advanceTimersByTimeAsync(60_000);
    await waitUntilFake(() => checkForUpdates.mock.calls.length === 1);
    await waitUntilFake(() => document.querySelector(".topbar .version-badge")?.textContent?.includes("v0.1.6") === true);
    expect(document.querySelector(".topbar .version-badge")?.textContent).toContain("v0.1.6 update");
    expect(document.body.textContent).toContain("Update v0.1.6 is available.");

    getButton("Dismiss notification").click();
    await waitUntilFake(() => document.querySelector(".toast") === null);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitUntilFake(() => checkForUpdates.mock.calls.length === 2);

    expect(document.querySelector(".toast")).toBeNull();
    expect(document.querySelector(".update-modal")).toBeNull();
  });

  it("retries 304 or failed periodic checks silently on the next interval", async () => {
    vi.useFakeTimers();
    const checkForUpdates = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(null);
    window.shell = {
      selectFolder: vi.fn(),
      selectFolders: vi.fn(),
      getUpdateAvailability: vi.fn().mockResolvedValue(null),
      checkForUpdates,
      onTrayScanNow: vi.fn(() => () => undefined),
      onUpdateAvailable: vi.fn(() => () => undefined),
      onUpdateProgress: vi.fn(() => () => undefined),
    };

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await waitUntilFake(() => document.querySelector(".topbar") !== null);

    await vi.advanceTimersByTimeAsync(180_000);
    await waitUntilFake(() => checkForUpdates.mock.calls.length === 3);

    expect(document.querySelector(".toast")).toBeNull();
  });

  it("keeps a toast for 60 seconds and dismisses it immediately with the close button", async () => {
    vi.spyOn(MockDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);
    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await settle();
    getButton("Open settings").click();
    await waitUntil(() => document.body.textContent?.includes("Similarity threshold") === true);

    vi.useFakeTimers();
    getButton("Save settings").click();
    await waitUntilFake(() => document.querySelector(".toast") !== null);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(document.body.textContent).toContain("Settings saved.");

    getButton("Dismiss notification").click();
    await waitUntilFake(() => document.querySelector(".toast") === null);
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("closes settings after a successful save", async () => {
    const putSettings = vi.spyOn(MockDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    getButton("Open settings").click();
    await waitUntil(() => document.body.textContent?.includes("Similarity threshold") === true);
    getButton("Save settings").click();

    await waitUntil(() => putSettings.mock.calls.length > 0);
    await waitUntil(() => document.querySelector(".settings-modal") === null);

    expect(document.body.textContent).toContain("Settings saved.");
  });

  it("saves the include online-only setting toggle", async () => {
    vi.spyOn(MockDataSource.prototype, "getSettings").mockResolvedValue({
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
      scan_folders: [],
      include_online_only: false,
    });
    const putSettings = vi.spyOn(MockDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    getButton("Open settings").click();
    await waitUntil(() => document.body.textContent?.includes("Include online-only files") === true);
    const section = Array.from(document.querySelectorAll(".settings-section"))
      .find((element) => element.textContent?.includes("Include online-only files"));
    const checkbox = section?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(checkbox).toBeTruthy();
    expect(checkbox?.checked).toBe(false);

    checkbox?.click();
    getButton("Save settings").click();

    await waitUntil(() => putSettings.mock.calls.length > 0);

    expect(putSettings).toHaveBeenCalledWith(expect.objectContaining({
      include_online_only: true,
    }));
  });

  it("shows cache location and clears only after confirmation", async () => {
    vi.spyOn(MockDataSource.prototype, "getCacheInfo")
      .mockResolvedValueOnce({
        cache_dir: "C:\\Users\\lisyo\\AppData\\Local\\Temp\\photo-dedup\\cache",
        snapshot_count: 2,
        snapshot_bytes: 2048,
      })
      .mockResolvedValueOnce({
        cache_dir: "C:\\Users\\lisyo\\AppData\\Local\\Temp\\photo-dedup\\cache",
        snapshot_count: 0,
        snapshot_bytes: 0,
      });
    const clearCache = vi.spyOn(MockDataSource.prototype, "clearCache").mockResolvedValue({ removed: 2 });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    getButton("Open settings").click();
    await waitUntil(() => {
      const input = document.querySelector(".cache-path-row input");
      return input instanceof HTMLInputElement && input.value === "C:\\Users\\lisyo\\AppData\\Local\\Temp\\photo-dedup\\cache";
    });
    expect(document.body.textContent).toContain("2 group list snapshots (2.00 KB)");

    getButton("Clear cache").click();
    await waitUntil(() => document.body.textContent?.includes("Clear group list cache") === true);
    getButton("Cancel").click();
    await waitUntil(() => document.body.textContent?.includes("Clear group list cache") === false);
    expect(clearCache).not.toHaveBeenCalled();

    getButton("Clear cache").click();
    await waitUntil(() => document.body.textContent?.includes("Photo files, scan data (manifest), and review completion history are kept") === true);
    getButton("Confirm").click();

    await waitUntil(() =>
      clearCache.mock.calls.length === 1 &&
      document.body.textContent?.includes("Cache cleared. Removed 2 snapshots.") === true
    );
    expect(document.body.textContent).toContain("0 group list snapshots (0 B)");
  });

  it("automatically dismisses an info toast after its timeout", async () => {
    vi.spyOn(MockDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    getButton("Open settings").click();
    await waitUntil(() => document.body.textContent?.includes("Similarity threshold") === true);

    vi.useFakeTimers();
    getButton("Save settings").click();
    await waitUntilFake(() => document.body.textContent?.includes("Settings saved.") === true);

    expect(document.body.textContent).toContain("Settings saved.");

    await vi.advanceTimersByTimeAsync(59_000);
    await flushPromises();
    expect(document.body.textContent).toContain("Settings saved.");

    await vi.advanceTimersByTimeAsync(1_100);
    await flushPromises();
    flushSync(() => undefined);
    expect(document.body.textContent).not.toContain("Settings saved.");
  });

  it("resets the toast timer when a new toast appears", async () => {
    vi.spyOn(MockDataSource.prototype, "putSettings")
      .mockImplementationOnce(async (settings) => settings)
      .mockRejectedValueOnce(new Error("Settings save failed"));

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    getButton("Open settings").click();
    await waitUntil(() => document.body.textContent?.includes("Similarity threshold") === true);

    vi.useFakeTimers();
    getButton("Save settings").click();
    await waitUntilFake(() => document.body.textContent?.includes("Settings saved.") === true);
    expect(document.body.textContent).toContain("Settings saved.");

    getButton("Open settings").click();
    await waitUntilFake(() => document.body.textContent?.includes("Similarity threshold") === true);
    getButton("Save settings").click();
    await waitUntilFake(() => document.body.textContent?.includes("Settings save failed") === true);
    expect(document.body.textContent).toContain("Settings save failed");

    await vi.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    expect(document.body.textContent).toContain("Settings save failed");

    await vi.advanceTimersByTimeAsync(30_100);
    await flushPromises();
    flushSync(() => undefined);
    expect(document.body.textContent).not.toContain("Settings save failed");
  });

  it("keeps settings open when save fails", async () => {
    vi.spyOn(MockDataSource.prototype, "putSettings").mockRejectedValue(new Error("Settings save failed"));

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    getButton("Open settings").click();
    await waitUntil(() => document.body.textContent?.includes("Similarity threshold") === true);
    getButton("Save settings").click();

    await waitUntil(() => document.body.textContent?.includes("Settings save failed") === true);

    expect(document.body.textContent).toContain("Similarity threshold");
    expect(document.querySelector(".settings-modal")).toBeTruthy();
  });

  it("ignores and removes the legacy lastRoot key when scan folders are saved", async () => {
    const legacyKey = "pdd.settings.lastRoot";
    const listGroupDetails = vi.spyOn(MockDataSource.prototype, "listGroupDetails");
    saveStoredScanFolders(["E:\\Settings Truth"]);
    window.localStorage.setItem(legacyKey, "D:\\Ignored Preview");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => listGroupDetails.mock.calls.length > 0);
    await waitUntil(() => window.localStorage.getItem(legacyKey) === null);

    expect(listGroupDetails).toHaveBeenCalledWith(["E:\\Settings Truth"], DEFAULT_GROUP_FILTERS);
    expect(document.body.textContent).toContain("E:\\Settings Truth");
    expect(document.body.textContent).not.toContain("D:\\Ignored Preview");
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
  });

  it("runs selected group actions from A/S/D keyboard shortcuts", async () => {
    saveStoredScanFolders(["D:\\Shortcut Photos"]);
    const applyGroupAction = vi.spyOn(MockDataSource.prototype, "applyGroupAction");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    await waitUntil(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".actions button")).some((button) => !button.disabled));
    await settle();

    dispatchShortcut("KeyA");
    await waitUntil(() =>
      applyGroupAction.mock.calls.length === 1 &&
      activeGroupTitle() === "#181"
    );
    dispatchShortcut("KeyS");
    await waitUntil(() =>
      applyGroupAction.mock.calls.length === 2 &&
      activeGroupTitle() === "#178"
    );
    dispatchShortcut("KeyD");
    await waitUntil(() =>
      applyGroupAction.mock.calls.length === 3 &&
      activeGroupTitle() === "#175"
    );

    expect(applyGroupAction.mock.calls.map((call) => call[1])).toEqual([
      "apply_recommended",
      "keep_all",
      "delete_all",
    ]);
    expect(document.querySelector(".actions button.shortcut-pressed")).toBeTruthy();
    expect(document.body.textContent).toContain("A");
    expect(document.body.textContent).toContain("S");
    expect(document.body.textContent).toContain("D");
  });

  it("toggles keep marks from photo card clicks including Ctrl click", async () => {
    saveStoredScanFolders(["D:\\Photo Click"]);
    const updateImage = vi.spyOn(MockDataSource.prototype, "updateImage");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    const cards = getPhotoCards();

    cards[1].click();
    await waitUntil(() => updateImage.mock.calls.length === 1);
    await waitUntil(() => document.querySelectorAll(".photo-card .mark-chip.keep").length === 2);
    expect(updateImage).toHaveBeenLastCalledWith(2, "keep");

    cards[1].click();
    await waitUntil(() => updateImage.mock.calls.length === 2);
    await waitUntil(() => document.querySelectorAll(".photo-card .mark-chip.keep").length === 1);
    expect(updateImage).toHaveBeenLastCalledWith(2, "none");

    ctrlClick(cards[1]);
    await waitUntil(() => updateImage.mock.calls.length === 3);
    await waitUntil(() => document.querySelectorAll(".photo-card .mark-chip.keep").length === 2);
    expect(updateImage).toHaveBeenLastCalledWith(2, "keep");
  });

  it("uses Enter and Space on focused photo cards for keep marks", async () => {
    saveStoredScanFolders(["D:\\Photo Keyboard"]);
    const updateImage = vi.spyOn(MockDataSource.prototype, "updateImage");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    const cards = getPhotoCards();
    cards[1].focus();

    dispatchKey(cards[1], "Enter");
    await waitUntil(() => updateImage.mock.calls.length === 1);
    await waitUntil(() => document.querySelectorAll(".photo-card .mark-chip.keep").length === 2);
    expect(updateImage).toHaveBeenLastCalledWith(2, "keep");

    dispatchKey(cards[1], " ", { ctrlKey: true });
    await waitUntil(() => updateImage.mock.calls.length === 2);
    await waitUntil(() => document.querySelectorAll(".photo-card .mark-chip.keep").length === 1);
    expect(updateImage).toHaveBeenLastCalledWith(2, "none");
  });

  it("does not double toggle keep when the keep MarkBox is clicked", async () => {
    saveStoredScanFolders(["D:\\MarkBox Click"]);
    const updateImage = vi.spyOn(MockDataSource.prototype, "updateImage");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    const keepCheckbox = document.querySelectorAll<HTMLInputElement>(".photo-card .mark-box input[type='checkbox']")[2];
    expect(keepCheckbox).toBeTruthy();

    keepCheckbox.click();
    await waitUntil(() => updateImage.mock.calls.length === 1);
    await waitUntil(() => document.querySelectorAll(".photo-card .mark-chip.keep").length === 2);

    expect(updateImage).toHaveBeenCalledTimes(1);
    expect(updateImage).toHaveBeenCalledWith(2, "keep");
  });

  it("runs A/S/D shortcuts while a photo mark checkbox has focus", async () => {
    saveStoredScanFolders(["D:\\Focused Photo"]);
    const applyGroupAction = vi.spyOn(MockDataSource.prototype, "applyGroupAction");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    const checkbox = document.querySelector<HTMLInputElement>(".photo-card input[type='checkbox']");
    expect(checkbox).toBeTruthy();
    checkbox!.focus();
    checkbox!.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true, cancelable: true }));

    await waitUntil(() => applyGroupAction.mock.calls.length === 1);
    await waitUntil(() => document.body.textContent?.includes("Group #181") === true);

    expect(applyGroupAction).toHaveBeenCalledWith(184, "keep_all");
  });

  it("uses the quick select setting to control group auto advance after A/S/D", async () => {
    saveStoredScanFolders(["D:\\Quick Select Off"]);
    saveStoredQuickSelect("false");
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const applyGroupAction = vi.spyOn(MockDataSource.prototype, "applyGroupAction");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    dispatchShortcut("KeyD");
    await waitUntil(() =>
      applyGroupAction.mock.calls.length === 1 &&
      document.body.textContent?.includes("Group #184") === true &&
      document.body.textContent.includes("Group #181") === false &&
      activeGroupTitle() === "#184"
    );

    expect(document.body.textContent).toContain("Group #184");
    expect(document.body.textContent).not.toContain("Group #181");
    expect(scrollIntoView).not.toHaveBeenCalled();

    root.unmount();
    container.innerHTML = "";
    root = createRoot(container);
    vi.restoreAllMocks();
    vi.spyOn(HttpDataSource.prototype, "getSettings").mockResolvedValue({
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
      scan_folders: [],
    });
    vi.spyOn(HttpDataSource.prototype, "loadGroupSnapshot").mockResolvedValue(null);
    saveStoredScanFolders(["D:\\Quick Select On"]);
    saveStoredQuickSelect("true");
    const scrollIntoViewOn = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewOn;
    const applyGroupActionOn = vi.spyOn(MockDataSource.prototype, "applyGroupAction");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    dispatchShortcut("KeyD");
    await waitUntil(() => applyGroupActionOn.mock.calls.length === 1);
    await waitUntil(() => document.body.textContent?.includes("Group #181") === true);
    await waitUntil(() => scrollIntoViewOn.mock.calls.length === 1);

    expect(scrollIntoViewOn).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("moves selection to the next group after a successful group action", async () => {
    saveStoredScanFolders(["D:\\Auto Advance Photos"]);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const applyGroupAction = vi.spyOn(MockDataSource.prototype, "applyGroupAction");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    getRequiredElement(".actions button").click();

    await waitUntil(() => document.body.textContent?.includes("Group #181") === true);
    await waitUntil(() => scrollIntoView.mock.calls.length === 1);

    expect(applyGroupAction).toHaveBeenCalledWith(184, "apply_recommended");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("keeps selection on the last group after a successful group action", async () => {
    saveStoredScanFolders(["D:\\Last Group Photos"]);
    const applyGroupAction = vi.spyOn(MockDataSource.prototype, "applyGroupAction");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    document.querySelectorAll<HTMLButtonElement>(".group-card").item(9).click();
    await waitUntil(() => document.body.textContent?.includes("Group #157") === true);

    dispatchShortcut("KeyD");
    await waitUntil(() =>
      applyGroupAction.mock.calls.length === 1 &&
      document.body.textContent?.includes("Group #157") === true &&
      activeGroupTitle() === "#157"
    );

    expect(applyGroupAction).toHaveBeenCalledWith(157, "delete_all");
    expect(document.body.textContent).toContain("Group #157");
  });

  it("does not move selection when a group action fails", async () => {
    saveStoredScanFolders(["D:\\Action Failure Photos"]);
    vi.spyOn(MockDataSource.prototype, "applyGroupAction").mockRejectedValueOnce(new Error("Action failed"));

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    dispatchShortcut("KeyS");

    await waitUntil(() => document.body.textContent?.includes("Action failed") === true);

    expect(document.body.textContent).toContain("Group #184");
    expect(document.body.textContent).not.toContain("Group #181");
  });

  it("moves group selection with ArrowUp and ArrowDown without wrapping", async () => {
    saveStoredScanFolders(["D:\\Arrow Photos"]);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);

    const down = dispatchShortcut("ArrowDown");
    await waitUntil(() => document.body.textContent?.includes("Group #181") === true);
    expect(down.defaultPrevented).toBe(true);

    const up = dispatchShortcut("ArrowUp");
    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    expect(up.defaultPrevented).toBe(true);

    const boundary = dispatchShortcut("ArrowUp");
    await settle();
    expect(boundary.defaultPrevented).toBe(true);
    expect(document.body.textContent).toContain("Group #184");
  });

  it("zooms detail thumbnails with Ctrl+wheel and persists the zoom", async () => {
    saveStoredScanFolders(["D:\\Zoom Photos"]);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    await settle();
    const grid = getPhotoGrid();

    const zoomIn = dispatchWheel(grid, -100, { ctrlKey: true });
    await waitUntil(() => grid.style.getPropertyValue("--thumbnail-zoom") === "1.15");
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(grid.style.getPropertyValue("--thumbnail-zoom")).toBe("1.15");
    expect(window.localStorage.getItem(THUMBNAIL_ZOOM_STORAGE_KEY)).toBe("1.15");

    const zoomOut = dispatchWheel(grid, 100, { ctrlKey: true });
    await waitUntil(() => grid.style.getPropertyValue("--thumbnail-zoom") === "1");
    expect(zoomOut.defaultPrevented).toBe(true);
    expect(grid.style.getPropertyValue("--thumbnail-zoom")).toBe("1");
    expect(window.localStorage.getItem(THUMBNAIL_ZOOM_STORAGE_KEY)).toBe("1");
  });

  it("zooms detail thumbnails with Ctrl keys, clamps limits, and resets with Ctrl+0", async () => {
    saveStoredScanFolders(["D:\\Zoom Key Photos"]);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    const grid = getPhotoGrid();

    const plus = dispatchShortcut("Equal", { key: "=", ctrlKey: true });
    await waitUntil(() => grid.style.getPropertyValue("--thumbnail-zoom") === "1.15");
    expect(plus.defaultPrevented).toBe(true);

    for (let index = 0; index < 20; index += 1) {
      dispatchShortcut("NumpadAdd", { key: "+", ctrlKey: true });
    }
    await waitUntil(() => grid.style.getPropertyValue("--thumbnail-zoom") === "3");
    expect(window.localStorage.getItem(THUMBNAIL_ZOOM_STORAGE_KEY)).toBe("3");

    for (let index = 0; index < 30; index += 1) {
      dispatchShortcut("Minus", { key: "-", ctrlKey: true });
    }
    await waitUntil(() => grid.style.getPropertyValue("--thumbnail-zoom") === "0.5");
    expect(window.localStorage.getItem(THUMBNAIL_ZOOM_STORAGE_KEY)).toBe("0.5");

    const reset = dispatchShortcut("Digit0", { key: "0", ctrlKey: true });
    await waitUntil(() => grid.style.getPropertyValue("--thumbnail-zoom") === "1");
    expect(reset.defaultPrevented).toBe(true);
    expect(window.localStorage.getItem(THUMBNAIL_ZOOM_STORAGE_KEY)).toBe("1");
  });

  it("restores persisted thumbnail zoom and defaults missing settings to 1x", async () => {
    saveStoredScanFolders(["D:\\Zoom Restore"]);
    window.localStorage.setItem(THUMBNAIL_ZOOM_STORAGE_KEY, "1.5");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    expect(getPhotoGrid().style.getPropertyValue("--thumbnail-zoom")).toBe("1.5");

    root.unmount();
    container.innerHTML = "";
    root = createRoot(container);
    vi.restoreAllMocks();
    vi.spyOn(HttpDataSource.prototype, "getSettings").mockResolvedValue({
      threshold: 90,
      recursive: true,
      extensions: ["jpg", "jpeg", "png", "heic", "webp"],
      cleanup_mode: "trash",
      scan_folders: [],
    });
    vi.spyOn(HttpDataSource.prototype, "loadGroupSnapshot").mockResolvedValue(null);
    window.localStorage.removeItem(THUMBNAIL_ZOOM_STORAGE_KEY);
    saveStoredScanFolders(["D:\\Zoom Default"]);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    expect(getPhotoGrid().style.getPropertyValue("--thumbnail-zoom")).toBe("1");
  });

  it("runs primary actions with Enter and Space outside editable controls", async () => {
    saveStoredScanFolders(["D:\\Primary Keyboard"]);
    saveStoredQuickSelect("false");
    const applyGroupAction = vi.spyOn(MockDataSource.prototype, "applyGroupAction");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);

    const enter = dispatchShortcut("Enter", { key: "Enter" });
    await waitUntil(() =>
      applyGroupAction.mock.calls.length === 1 &&
      document.body.textContent?.includes("Group #184") === true &&
      document.body.textContent.includes("Group #181") === false &&
      activeGroupTitle() === "#184"
    );
    const space = dispatchShortcut("Space", { key: " " });
    await waitUntil(() =>
      applyGroupAction.mock.calls.length === 2 &&
      document.body.textContent?.includes("Group #184") === true &&
      document.body.textContent.includes("Group #181") === false &&
      activeGroupTitle() === "#184"
    );

    expect(enter.defaultPrevented).toBe(true);
    expect(space.defaultPrevented).toBe(true);
    expect(applyGroupAction.mock.calls.map((call) => call[1])).toEqual([
      "apply_recommended",
      "apply_recommended",
    ]);
  });

  it("uses Enter or Space for modal primary actions and Esc to cancel or close", async () => {
    saveStoredScanFolders(["D:\\Modal Keyboard"]);
    const detail = applyGroupDetail();
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [detail],
      next_cursor: null,
      total_estimate: 1,
    });
    vi.spyOn(MockDataSource.prototype, "getGroup").mockResolvedValue(detail);
    const applyMarkedDeletes = vi.spyOn(MockDataSource.prototype, "applyMarkedDeletes").mockResolvedValue({
      job_id: "keyboard-cleanup",
      status: "queued",
      targets: 1,
    });
    vi.spyOn(MockDataSource.prototype, "getCleanup").mockResolvedValue({
      id: "keyboard-cleanup",
      kind: "cleanup",
      status: "done",
      phase: "done",
      done: 1,
      total: 1,
      summary: { deleted: 1, failed: 0 },
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("#101") === true);
    getRequiredElement(".apply-button").click();
    await waitUntil(() => document.querySelector(".modal") !== null);
    const enter = dispatchShortcut("Enter", { key: "Enter" });

    await waitUntil(() => applyMarkedDeletes.mock.calls.length === 1);
    expect(enter.defaultPrevented).toBe(true);
    await waitUntil(() => document.querySelector("[aria-labelledby='apply-title'] .modal") === null);

    const putSettings = vi.spyOn(MockDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);
    getButton("Open settings").click();
    await waitUntil(() => document.querySelector(".settings-modal") !== null);
    const space = dispatchShortcut("Space", { key: " " });
    await waitUntil(() => putSettings.mock.calls.length === 1);
    await waitUntil(() => document.querySelector(".settings-modal") === null);
    expect(space.defaultPrevented).toBe(true);

    getRequiredElement(".apply-button").click();
    await waitUntil(() => document.querySelector(".modal") !== null);
    const escape = dispatchShortcut("Escape");
    await waitUntil(() => document.querySelector(".modal") === null);
    expect(escape.defaultPrevented).toBe(false);
  });

  it("routes Enter and Space to the apply modal while the main apply button has focus", async () => {
    saveStoredScanFolders(["D:\\Apply Focus"]);
    const detail = applyGroupDetail();
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [detail],
      next_cursor: null,
      total_estimate: 1,
    });
    vi.spyOn(MockDataSource.prototype, "getGroup").mockResolvedValue(detail);
    const applyMarkedDeletes = vi.spyOn(MockDataSource.prototype, "applyMarkedDeletes").mockResolvedValue({
      job_id: "focus-cleanup",
      status: "queued",
      targets: 1,
    });
    vi.spyOn(MockDataSource.prototype, "getCleanup").mockResolvedValue({
      id: "focus-cleanup",
      kind: "cleanup",
      status: "done",
      phase: "done",
      done: 1,
      total: 1,
      summary: { deleted: 1, failed: 0 },
    });

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("#101") === true);
    const mainApplyButton = getRequiredElement(".apply-button");
    mainApplyButton.focus();
    mainApplyButton.click();
    await waitUntil(() => document.querySelector(".modal") !== null);
    expect(document.activeElement).toBe(getButton("Apply all"));

    mainApplyButton.focus();
    const enter = dispatchKey(mainApplyButton, "Enter", { code: "Enter" });
    await waitUntil(() => applyMarkedDeletes.mock.calls.length === 1);
    expect(enter.defaultPrevented).toBe(true);

    await waitUntil(() => document.querySelector(".modal") === null);
    mainApplyButton.click();
    await waitUntil(() => document.querySelector(".modal") !== null);
    mainApplyButton.focus();
    const space = dispatchKey(mainApplyButton, " ", { code: "Space" });
    await waitUntil(() => applyMarkedDeletes.mock.calls.length === 2);
    expect(space.defaultPrevented).toBe(true);

    await waitUntil(() => document.querySelector(".modal") === null);
    mainApplyButton.click();
    await waitUntil(() => document.querySelector(".modal") !== null);
    const escape = dispatchShortcut("Escape");
    await waitUntil(() => document.querySelector(".modal") === null);
    expect(escape.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(mainApplyButton);
  });

  it("prevents the default save action for Ctrl+S when apply-all is disabled", async () => {
    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await settle();

    const shortcut = dispatchShortcut("KeyS", { key: "s", ctrlKey: true });

    expect(shortcut.defaultPrevented).toBe(true);
    expect(document.querySelector("[aria-labelledby='apply-title']")).toBeNull();
  });

  it("opens the same apply-all confirmation flow for Ctrl+S as the button", async () => {
    saveStoredScanFolders(["D:\\Apply Shortcut"]);
    const detail = applyGroupDetail();
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [detail],
      next_cursor: null,
      total_estimate: 1,
    });
    vi.spyOn(MockDataSource.prototype, "getGroup").mockResolvedValue(detail);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await waitUntil(() => document.body.textContent?.includes("#101") === true);

    const applyButton = getRequiredElement(".apply-button");
    expect(applyButton.getAttribute("title")).toBe("Apply all (Ctrl+S)");
    const shortcut = dispatchShortcut("KeyS", { key: "S", ctrlKey: true });
    await waitUntil(() => document.querySelector("[aria-labelledby='apply-title']") !== null);

    expect(shortcut.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(getButton("Apply all"));
  });

  it("does not open apply-all for Ctrl+S while another modal is open", async () => {
    saveStoredScanFolders(["D:\\Apply Shortcut Modal"]);
    const detail = applyGroupDetail();
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [detail],
      next_cursor: null,
      total_estimate: 1,
    });
    vi.spyOn(MockDataSource.prototype, "getGroup").mockResolvedValue(detail);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await waitUntil(() => document.body.textContent?.includes("#101") === true);
    getButton("Open settings").click();
    await waitUntil(() => document.querySelector(".settings-modal") !== null);

    const shortcut = dispatchShortcut("KeyS", { key: "s", ctrlKey: true });
    await settle();

    expect(shortcut.defaultPrevented).toBe(true);
    expect(document.querySelector("[aria-labelledby='apply-title']")).toBeNull();
    expect(document.querySelector(".settings-modal")).toBeTruthy();
  });

  it("opens apply-all for macOS Cmd+S", async () => {
    saveStoredScanFolders(["D:\\Apply Shortcut Meta"]);
    const detail = applyGroupDetail();
    vi.spyOn(MockDataSource.prototype, "listGroupDetails").mockResolvedValue({
      items: [detail],
      next_cursor: null,
      total_estimate: 1,
    });
    vi.spyOn(MockDataSource.prototype, "getGroup").mockResolvedValue(detail);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await waitUntil(() => document.body.textContent?.includes("#101") === true);

    const shortcut = dispatchShortcut("KeyS", { key: "s", metaKey: true });
    await waitUntil(() => document.querySelector("[aria-labelledby='apply-title']") !== null);

    expect(shortcut.defaultPrevented).toBe(true);
  });

  it("does not run default keyboard actions while an input has focus", async () => {
    saveStoredScanFolders(["D:\\Input Guard"]);
    const applyGroupAction = vi.spyOn(MockDataSource.prototype, "applyGroupAction");
    const putSettings = vi.spyOn(MockDataSource.prototype, "putSettings").mockImplementation(async (settings) => settings);

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);
    putSettings.mockClear();
    getButton("Open settings").click();
    await waitUntil(() => document.querySelector(".settings-modal") !== null);
    const input = getAriaInput("Folder path");
    input.focus();

    const enter = dispatchKey(input, "Enter", { code: "Enter" });
    const space = dispatchKey(input, " ", { code: "Space" });
    await settle();

    expect(enter.defaultPrevented).toBe(false);
    expect(space.defaultPrevented).toBe(false);
    expect(applyGroupAction).not.toHaveBeenCalled();
    expect(putSettings).not.toHaveBeenCalled();
    expect(document.querySelector(".settings-modal")).toBeTruthy();
  });

  it("ignores group action shortcuts without a selectable review target", async () => {
    const applyGroupAction = vi.spyOn(MockDataSource.prototype, "applyGroupAction");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await settle();
    dispatchShortcut("KeyA");
    await settle();

    expect(applyGroupAction).not.toHaveBeenCalled();
  });

  it("ignores group action shortcuts while modals, editable targets, or modifiers are active", async () => {
    saveStoredScanFolders(["D:\\Shortcut Guard Photos"]);
    const applyGroupAction = vi.spyOn(MockDataSource.prototype, "applyGroupAction");

    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitUntil(() => document.body.textContent?.includes("Group #184") === true);

    getButton("Open settings").click();
    await waitUntil(() => document.querySelector(".settings-modal") !== null);
    dispatchShortcut("KeyA");
    await settle();
    expect(applyGroupAction).not.toHaveBeenCalled();
    getButton("Close").click();
    await waitUntil(() => document.querySelector(".settings-modal") === null);

    getButton("Open help").click();
    await waitUntil(() => document.body.textContent?.includes("How duplicate review works") === true);
    dispatchShortcut("KeyS");
    await settle();
    expect(applyGroupAction).not.toHaveBeenCalled();
    getButton("Close help").click();
    await waitUntil(() => document.body.textContent?.includes("How duplicate review works") === false);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", bubbles: true }));
    await settle();
    input.remove();

    dispatchShortcut("KeyA", { ctrlKey: true });
    dispatchShortcut("KeyS", { altKey: true });
    dispatchShortcut("KeyD", { metaKey: true });
    dispatchShortcut("ArrowDown", { isComposing: true });
    dispatchShortcut("ArrowDown", { shiftKey: true });
    await settle();

    expect(applyGroupAction).not.toHaveBeenCalled();
  });

  it("renders the help view manual sections", async () => {
    root.render(
      <I18nProvider>
        <HelpView onClose={() => undefined} />
      </I18nProvider>
    );
    await settle();

    expect(document.body.textContent).toContain("Workflow");
    expect(document.body.textContent).toContain("Processing Pipeline");
    expect(document.body.textContent).toContain("Similarity System");
    expect(document.body.textContent).toContain("Keep Recommendation");
    expect(document.body.textContent).toContain("Review Indicators");
  });

  it("closes the help view when the backdrop is clicked", async () => {
    const onClose = vi.fn();

    root.render(
      <I18nProvider>
        <HelpView onClose={onClose} />
      </I18nProvider>
    );
    await settle();

    getRequiredElement(".modal-backdrop").click();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the help view open when modal content is clicked", async () => {
    const onClose = vi.fn();

    root.render(
      <I18nProvider>
        <HelpView onClose={onClose} />
      </I18nProvider>
    );
    await settle();

    getRequiredElement(".help-modal").click();

    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens and closes help from the topbar", async () => {
    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
    await settle();

    getButton("Open help").click();
    await settle();
    expect(document.body.textContent).toContain("How duplicate review works");

    getButton("Close help").click();
    await settle();
    expect(document.body.textContent).not.toContain("How duplicate review works");

    getButton("Open help").click();
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(document.body.textContent).not.toContain("How duplicate review works");
  });
});

function expectLanguageLabels(englishLabel: string) {
  expect(getInputByLabel(englishLabel)).toBeTruthy();
  expect(getInputByLabel("한국어")).toBeTruthy();
  expect(getInputByLabel("日本語")).toBeTruthy();
}

function applyGroupDetail(): GroupDetail {
  return {
    group: {
      id: 101,
      member_count: 2,
      recommended_keep_image_id: 1,
      selection_state: "mixed",
      max_similarity: 99.1,
      reclaimable_bytes: 1_000,
      thumbnail_image_id: 1,
    },
    images: [
      {
        id: 1,
        path: "D:\\Apply Photos\\keep.jpg",
        size_bytes: 2_000,
        width: 100,
        height: 100,
        format: "jpg",
        quality_score: 95,
        mark: "keep",
        recommended_keep: true,
        is_quarantined: false,
      },
      {
        id: 2,
        path: "D:\\Apply Photos\\delete.jpg",
        size_bytes: 1_000,
        width: 100,
        height: 100,
        format: "jpg",
        quality_score: 80,
        mark: "delete",
        recommended_keep: false,
        is_quarantined: false,
      },
    ],
  };
}

function scanFolderGroupDetail(rootPath: string): GroupDetail {
  return {
    group: {
      id: 501,
      member_count: 2,
      recommended_keep_image_id: 5011,
      selection_state: "mixed",
      max_similarity: 98,
      reclaimable_bytes: 1_000,
      thumbnail_image_id: 5011,
    },
    images: [
      {
        id: 5011,
        path: `${rootPath}\\one.jpg`,
        size_bytes: 2_000,
        width: 100,
        height: 100,
        format: "jpg",
        quality_score: 95,
        mark: "none",
        recommended_keep: true,
        is_quarantined: false,
      },
      {
        id: 5012,
        path: `${rootPath}\\two.jpg`,
        size_bytes: 1_000,
        width: 100,
        height: 100,
        format: "jpg",
        quality_score: 80,
        mark: "none",
        recommended_keep: false,
        is_quarantined: false,
      },
    ],
  };
}

function saveStoredScanFolders(folders: string[], updatedAt = "2026-07-14T00:00:00.000Z") {
  window.localStorage.setItem(SCAN_FOLDERS_STORAGE_KEY, JSON.stringify(folders));
  window.localStorage.setItem(SCAN_FOLDERS_UPDATED_AT_STORAGE_KEY, updatedAt);
}

function saveStoredBackgroundScanInterval(intervalHours: string) {
  window.localStorage.setItem(BACKGROUND_SCAN_INTERVAL_STORAGE_KEY, intervalHours);
}

function saveStoredBackgroundScanLastStartedAt(startedAt: number) {
  window.localStorage.setItem(BACKGROUND_SCAN_LAST_STARTED_STORAGE_KEY, String(startedAt));
}

function saveStoredQuickSelect(enabled: string) {
  window.localStorage.setItem(QUICK_SELECT_STORAGE_KEY, enabled);
}

function getPhotoCards(): HTMLElement[] {
  const cards = Array.from(document.querySelectorAll(".photo-card"));
  if (cards.length === 0 || !cards.every((card): card is HTMLElement => card instanceof HTMLElement)) {
    throw new Error("Photo cards not found");
  }
  return cards;
}

function getPhotoGrid(): HTMLElement {
  return getRequiredElement(".photo-grid");
}

function activeGroupTitle(): string | null {
  return document.querySelector(".group-card.active .group-title")?.textContent?.trim() ?? null;
}

function getButton(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name
  );

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }

  return button;
}

function getRequiredElement(selector: string): HTMLElement {
  const element = document.querySelector(selector);

  if (!(element instanceof HTMLElement)) {
    throw new Error(`Element not found: ${selector}`);
  }

  return element;
}

function getInputByLabel(labelText: string): HTMLInputElement {
  const input = Array.from(document.querySelectorAll("label")).find(
    (label) => label.textContent?.trim() === labelText
  )?.querySelector("input");

  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${labelText}`);
  }

  return input;
}

function getRange(labelText: string): HTMLInputElement {
  const input = document.querySelector(`input[type="range"][aria-label="${labelText}"]`);

  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Range not found: ${labelText}`);
  }

  return input;
}

function getSelectByLabel(labelText: string): HTMLSelectElement {
  const select = document.querySelector(`select[aria-label="${labelText}"]`);

  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Select not found: ${labelText}`);
  }

  return select;
}

function selectOption(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function getAriaInput(labelText: string): HTMLInputElement {
  const input = document.querySelector(`input[aria-label="${labelText}"]`);

  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${labelText}`);
  }

  return input;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}

function dispatchShortcut(code: string, init: KeyboardEventInit = {}) {
  const key = init.key ?? (code === "Escape" ? "Escape" : code === "ArrowUp" ? "ArrowUp" : code === "ArrowDown" ? "ArrowDown" : undefined);
  const event = new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

function dispatchKey(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function ctrlClick(target: EventTarget) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
  target.dispatchEvent(event);
  return event;
}

function dispatchWheel(target: EventTarget, deltaY: number, init: WheelEventInit = {}) {
  const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function settle() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await settle();
  }

  throw new Error("Timed out waiting for condition");
}

async function waitUntilFake(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushPromises();
    flushSync(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
  }

  throw new Error("Timed out waiting for condition");
}

function setUserAgent(userAgent: string) {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}
