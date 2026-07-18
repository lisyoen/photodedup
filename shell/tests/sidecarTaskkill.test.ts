import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidecarManager } from "../src/sidecar";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

interface TerminableSidecarManager {
  terminateExistingSidecar(pid: number, source: string): void;
  bufferedLogs: readonly string[];
}

describe("SidecarManager Windows taskkill cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(execFileSync).mockReset();
  });

  it("does not inherit taskkill stderr when terminating stale Windows sidecars", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const manager = new SidecarManager() as unknown as TerminableSidecarManager;

    manager.terminateExistingSidecar(42272, "pid file");

    expect(execFileSync).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "42272", "/T", "/F"],
      expect.objectContaining({
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5_000,
      }),
    );
  });

  it("treats taskkill status 128 as a stale pid instead of a failed termination", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(execFileSync).mockImplementation(() => {
      const error = new Error("ERROR: The process 42272 not found") as Error & { status: number };
      error.status = 128;
      throw error;
    });
    const manager = new SidecarManager() as unknown as TerminableSidecarManager;

    manager.terminateExistingSidecar(42272, "pid file");

    expect(manager.bufferedLogs).toContain("stale sidecar pid=42272 already gone");
    expect(manager.bufferedLogs.some((line) => line.includes("failed to terminate existing sidecar"))).toBe(false);
  });
});
