import { describe, expect, it, vi } from "vitest";
import { checkUpdateStatus, compareSemver, resolveUpdateAvailability, resolveUpdateStatus } from "../src/update";

describe("compareSemver", () => {
  it("detects a newer patch version", () => {
    expect(compareSemver("0.1.2", "0.1.1")).toBe(1);
  });

  it("detects equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("detects an older version", () => {
    expect(compareSemver("1.2.2", "1.2.3")).toBe(-1);
  });

  it("accepts a v-prefixed version", () => {
    expect(compareSemver("v2.0.0", "1.9.9")).toBe(1);
  });

  it("rejects malformed versions", () => {
    expect(compareSemver("1.2", "1.2.0")).toBeNull();
    expect(compareSemver("latest", "1.2.0")).toBeNull();
  });
});

describe("update availability", () => {
  it("returns update status when the latest release is newer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        tag_name: "v0.2.0",
        html_url: "https://github.com/lisyoen/photodedup/releases/tag/v0.2.0",
      }),
    }) as unknown as typeof fetch;

    await expect(checkUpdateStatus({
      currentVersion: "0.1.1",
      isSourceInstall: true,
      fetchImpl,
    })).resolves.toEqual({
      latest: "0.2.0",
      current: "0.1.1",
      htmlUrl: "https://github.com/lisyoen/photodedup/releases/tag/v0.2.0",
      updateAvailable: true,
      isSourceInstall: true,
    });
  });

  it("returns latest status without availability when the release is current or older", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        tag_name: "v0.1.0",
        html_url: "https://github.com/lisyoen/photodedup/releases/tag/v0.1.0",
      }),
    }) as unknown as typeof fetch;

    await expect(checkUpdateStatus({
      currentVersion: "0.1.1",
      isSourceInstall: true,
      fetchImpl,
    })).resolves.toEqual({
      current: "0.1.1",
      latest: "0.1.0",
      htmlUrl: "https://github.com/lisyoen/photodedup/releases/tag/v0.1.0",
      updateAvailable: false,
      isSourceInstall: true,
    });
  });

  it("keeps resolveUpdateAvailability backward compatible for unavailable releases", () => {
    expect(resolveUpdateAvailability({ tag_name: "v0.2.0" }, "0.1.1", true)).toBeNull();
  });

  it("returns a failed lookup status for network failures", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    await expect(checkUpdateStatus({
      currentVersion: "0.1.1",
      isSourceInstall: true,
      fetchImpl,
      timeoutMs: 1,
    })).resolves.toEqual({
      current: "0.1.1",
      latest: null,
      htmlUrl: null,
      updateAvailable: false,
      isSourceInstall: true,
    });
  });

  it("returns failed lookup status for malformed release payloads", () => {
    expect(resolveUpdateStatus({ tag_name: "v0.2.0" }, "0.1.1", true)).toEqual({
      current: "0.1.1",
      latest: null,
      htmlUrl: null,
      updateAvailable: false,
      isSourceInstall: true,
    });
  });
});
