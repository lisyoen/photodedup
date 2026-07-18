import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineConnectionError, createDataSource, HttpDataSource, MockDataSource, isElectronRuntime } from "./api";

describe("HttpDataSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends X-Api-Token on JSON requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      scan_id: "scan-1",
      status: "queued",
    }));
    const dataSource = new HttpDataSource({ port: 49152, token: "secret-token" });

    await dataSource.startScan({ roots: ["D:\\Photos"] });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49152/scan", {
      method: "POST",
      body: JSON.stringify({ roots: ["D:\\Photos"] }),
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": "secret-token",
      },
    });
  });

  it("throws on 401 responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    const dataSource = new HttpDataSource({ port: 49152, token: "bad-token" });

    await expect(dataSource.listGroups()).rejects.toThrow("GET /groups?limit=200&sort=reclaimable_bytes&status=unresolved failed with 401");
  });

  it("loads health status with manifest counts", async () => {
    const health = {
      status: "ok",
      version: "0.1.0",
      db_path: "C:\\Data\\manifest.db",
      thumbs_dir: "C:\\Data\\thumbs",
      images: 12,
      groups: 4,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(health));
    const dataSource = new HttpDataSource({ port: 49152, token: "secret-token" });

    await expect(dataSource.getHealth()).resolves.toEqual(health);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49152/healthz", {
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": "secret-token",
      },
    });
  });

  it("serializes selected roots as repeated group query parameters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    }));
    const dataSource = new HttpDataSource({ port: 49152, token: "secret-token" });

    await dataSource.listGroups(["C:\\A", "C:\\B"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/groups?limit=200&sort=reclaimable_bytes&status=unresolved&roots=C%3A%5CA&roots=C%3A%5CB",
      {
        headers: {
          "Content-Type": "application/json",
          "X-Api-Token": "secret-token",
        },
      }
    );
  });

  it("serializes group status and sort filters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    }));
    const dataSource = new HttpDataSource({ port: 49152, token: "secret-token" });

    await dataSource.listGroups(["C:\\A"], { status: "processed", sort: "similarity" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/groups?limit=200&sort=similarity&status=processed&roots=C%3A%5CA",
      {
        headers: {
          "Content-Type": "application/json",
          "X-Api-Token": "secret-token",
        },
      }
    );
  });

  it("maps savings sort to reclaimable_bytes for group queries", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    }));
    const dataSource = new HttpDataSource({ port: 49152, token: "secret-token" });

    await dataSource.listGroups(["C:\\A"], { status: "all", sort: "savings" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/groups?limit=200&sort=reclaimable_bytes&status=all&roots=C%3A%5CA",
      expect.any(Object)
    );
  });

  it("requests bulk group details with include=details", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    }));
    const dataSource = new HttpDataSource({ port: 49152, token: "secret-token" });

    await dataSource.listGroupDetails(["C:\\A"], { status: "all", sort: "savings" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/groups?limit=10000&sort=reclaimable_bytes&status=all&include=details&roots=C%3A%5CA",
      expect.any(Object)
    );
  });

  it("serializes selected roots for group detail requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      group: {
        id: 42,
        member_count: 2,
        recommended_keep_image_id: 1,
        selection_state: "mixed",
        max_similarity: 90,
        reclaimable_bytes: 100,
        thumbnail_image_id: 1,
      },
      images: [],
    }));
    const dataSource = new HttpDataSource({ port: 49152, token: "secret-token" });

    await dataSource.getGroup(42, ["C:\\A", "C:\\B"]);

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49152/groups/42?roots=C%3A%5CA&roots=C%3A%5CB", {
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": "secret-token",
      },
    });
  });

  it("serializes settings requests with X-Api-Token", async () => {
    const settings = {
      threshold: 95,
      recursive: true,
      extensions: ["jpg", "png"],
      cleanup_mode: "trash" as const,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(settings));
    const dataSource = new HttpDataSource({ port: 49152, token: "secret-token" });

    await dataSource.putSettings(settings);

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49152/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": "secret-token",
      },
    });
  });

  it("loads and clears cache with X-Api-Token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        cache_dir: "C:\\Data\\cache",
        snapshot_count: 2,
        snapshot_bytes: 123,
      }))
      .mockResolvedValueOnce(jsonResponse({ removed: 2 }));
    const dataSource = new HttpDataSource({ port: 49152, token: "secret-token" });

    await expect(dataSource.getCacheInfo()).resolves.toEqual({
      cache_dir: "C:\\Data\\cache",
      snapshot_count: 2,
      snapshot_bytes: 123,
    });
    await expect(dataSource.clearCache()).resolves.toEqual({ removed: 2 });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://127.0.0.1:49152/cache/info", {
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": "secret-token",
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://127.0.0.1:49152/cache/clear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": "secret-token",
      },
    });
  });

  it("sends X-Api-Token when loading thumbnails", async () => {
    URL.createObjectURL = vi.fn(() => "blob:thumb");
    const createObjectUrl = vi.mocked(URL.createObjectURL);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve({} as Blob),
    } as Response);
    const dataSource = new HttpDataSource({ port: 49152, token: "secret-token" });

    await expect(dataSource.loadThumbSrc({
      id: 42,
      path: "D:\\Photos\\IMG.jpg",
      size_bytes: 10,
      width: 1,
      height: 1,
      format: "jpg",
      quality_score: 90,
      mark: "none",
      recommended_keep: false,
      is_quarantined: false,
    })).resolves.toBe("blob:thumb");

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49152/thumbs/42", {
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": "secret-token",
      },
    });
    expect(createObjectUrl).toHaveBeenCalledOnce();
  });
});

describe("createDataSource", () => {
  const originalUserAgent = navigator.userAgent;

  afterEach(() => {
    delete window.sidecar;
    setUserAgent(originalUserAgent);
  });

  it("uses HttpDataSource when window.sidecar exists", () => {
    window.sidecar = { port: 49152, token: "secret-token" };
    expect(createDataSource()).toBeInstanceOf(HttpDataSource);
  });

  it("falls back to MockDataSource without window.sidecar", () => {
    delete window.sidecar;
    expect(createDataSource()).toBeInstanceOf(MockDataSource);
  });

  it("blocks MockDataSource inside Electron when window.sidecar is missing", () => {
    setUserAgent("Mozilla/5.0 Electron/33.2.1");
    delete window.sidecar;

    expect(isElectronRuntime()).toBe(true);
    expect(() => createDataSource()).toThrow(EngineConnectionError);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setUserAgent(userAgent: string) {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}
