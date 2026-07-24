import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkUpdateStatus,
  compareSemver,
  resolveUpdateAvailability,
  resolveUpdateStatus,
  runSourceUpdate,
  UPDATE_STAGES,
} from "../src/update";

const spawnCalls = vi.hoisted(() => [] as Array<{
  command: string;
  args: string[];
  options: { cwd?: string; shell?: boolean };
}>);

vi.mock("node:child_process", () => {
  const makeEmitter = () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args);
        }
      },
    };
  };

  return {
    spawn: vi.fn((command: string, args: string[], options: { cwd?: string; shell?: boolean }) => {
      spawnCalls.push({ command, args, options });
      const child = makeEmitter();
      Object.assign(child, {
        stdout: makeEmitter(),
        stderr: makeEmitter(),
      });
      setImmediate(() => child.emit("close", 0, null));
      return child;
    }),
  };
});

beforeEach(() => {
  spawnCalls.length = 0;
});

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

  it("reuses the ETag and cached release when GitHub returns 304", async () => {
    const json = vi.fn().mockResolvedValue({
      tag_name: "v0.3.0",
      html_url: "https://github.com/lisyoen/photodedup/releases/tag/v0.3.0",
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: vi.fn().mockReturnValue("\"release-v3\"") },
        json,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 304,
        headers: { get: vi.fn() },
        json: vi.fn(),
      }) as unknown as typeof fetch;

    await checkUpdateStatus({ currentVersion: "0.1.1", isSourceInstall: true, fetchImpl });
    await expect(checkUpdateStatus({
      currentVersion: "0.1.1",
      isSourceInstall: true,
      fetchImpl,
    })).resolves.toMatchObject({ latest: "0.3.0", updateAvailable: true });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "If-None-Match": "\"release-v3\"" }),
      })
    );
    expect(json).toHaveBeenCalledTimes(1);
  });
});

describe("runSourceUpdate", () => {
  it("runs source update npm steps inside package directories without --prefix", async () => {
    const repoRoot = path.join(path.sep, "tmp", "photo-dedup-desktop");

    await expect(runSourceUpdate({
      repoRoot,
      log: vi.fn(),
      onProgress: vi.fn(),
    })).resolves.toEqual({ ok: true });

    expect(spawnCalls).toEqual([
      {
        command: "git",
        args: ["pull", "origin", "main"],
        options: { cwd: repoRoot, shell: process.platform === "win32" },
      },
      {
        command: "npm",
        args: ["install", "--no-audit", "--no-fund"],
        options: { cwd: path.join(repoRoot, "renderer"), shell: process.platform === "win32" },
      },
      {
        command: "npm",
        args: ["run", "build"],
        options: { cwd: path.join(repoRoot, "renderer"), shell: process.platform === "win32" },
      },
      {
        command: "npm",
        args: ["install", "--no-audit", "--no-fund"],
        options: { cwd: path.join(repoRoot, "shell"), shell: process.platform === "win32" },
      },
      {
        command: "npm",
        args: ["run", "build"],
        options: { cwd: path.join(repoRoot, "shell"), shell: process.platform === "win32" },
      },
    ]);
    expect(spawnCalls.flatMap((call) => call.args)).not.toContain("--prefix");
  });

  it("keeps update stage labels aligned with cwd-based commands", () => {
    expect(UPDATE_STAGES.map((stage) => stage.label)).toEqual([
      "git pull origin main",
      "renderer: npm install --no-audit --no-fund",
      "renderer: npm run build",
      "shell: npm install --no-audit --no-fund",
      "shell: npm run build",
    ]);
  });
});
