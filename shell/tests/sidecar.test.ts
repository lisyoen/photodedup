import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextSidecarRestart, resolveSidecarCommand, sidecarCommandLineDataDirs, SidecarManager } from "../src/sidecar";

interface ResolvableSidecarManager {
  resolveCommand(): { executable: string; args: string[]; cwd: string };
}

describe("SidecarManager", () => {
  let manager: SidecarManager | null = null;
  let dataDir: string | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.stop();
      manager = null;
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = null;
    }
  });

  it("spawns server.py, parses the handshake, serves authenticated API calls, and stops", async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "photo-dedup-sidecar-"));
    manager = new SidecarManager({
      mode: "dev",
      projectRoot: path.resolve(__dirname, "..", ".."),
      dataDir,
    });

    const handshake = await manager.start();
    expect(handshake.port).toBeGreaterThan(0);
    expect(handshake.token.length).toBeGreaterThan(0);
    expect(manager.pid).toBeGreaterThan(0);

    const baseUrl = `http://127.0.0.1:${handshake.port}`;
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);

    const groups = await fetch(`${baseUrl}/groups`, {
      headers: { "X-Api-Token": handshake.token },
    });
    expect(groups.status).toBe(200);

    const pid = manager.pid;
    await manager.stop();
    expect(manager.isRunning).toBe(false);

    if (pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`sidecar process ${pid} is still alive`);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      }
    }
  }, 20_000);

  it("uses the Windows venv python executable in dev mode on win32", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const projectRoot = path.resolve("C:\\Users\\lisyo\\projects\\photo-dedup-desktop");
      manager = new SidecarManager({
        mode: "dev",
        projectRoot,
        dataDir: "C:\\Users\\lisyo\\.photo-dedup-desktop-test",
      });

      const command = (manager as unknown as ResolvableSidecarManager).resolveCommand();

      expect(command.executable).toBe(path.join(projectRoot, "engine", ".venv", "Scripts", "python.exe"));
      expect(command.args).toEqual(["-m", "photodedup.server", "--data-dir", "C:\\Users\\lisyo\\.photo-dedup-desktop-test"]);
      expect(command.cwd).toBe(path.join(projectRoot, "engine"));
    } finally {
      platform.mockRestore();
    }
  });

  it("resolves packaged Linux sidecar from process resources", () => {
    const command = resolveSidecarCommand({
      mode: "prod",
      projectRoot: "/repo",
      resourcesPath: "/tmp/PhotoDedup/resources",
      platform: "linux",
      dataDir: "/tmp/photo-dedup-data",
    });

    expect(command.executable).toBe("/tmp/PhotoDedup/resources/sidecar/linux/photodedup-sidecar/photodedup-sidecar");
    expect(command.args).toEqual(["--data-dir", "/tmp/photo-dedup-data"]);
    expect(command.cwd).toBe("/tmp/PhotoDedup/resources");
  });

  it("resolves packaged Windows sidecar with .exe suffix", () => {
    const command = resolveSidecarCommand({
      mode: "prod",
      projectRoot: "C:\\repo",
      resourcesPath: "C:\\Program Files\\PhotoDedup\\resources",
      platform: "win32",
      dataDir: "C:\\Users\\lisyo\\AppData\\Local\\PhotoDedup",
    });

    expect(command.executable).toBe(
      path.join("C:\\Program Files\\PhotoDedup\\resources", "sidecar", "win32", "photodedup-sidecar", "photodedup-sidecar.exe")
    );
    expect(command.args).toEqual(["--data-dir", "C:\\Users\\lisyo\\AppData\\Local\\PhotoDedup"]);
    expect(command.cwd).toBe("C:\\Program Files\\PhotoDedup\\resources");
  });

  it("limits crash restarts to three backoff attempts", () => {
    expect(nextSidecarRestart(1)).toEqual({ attempt: 1, delayMs: 1_000 });
    expect(nextSidecarRestart(2)).toEqual({ attempt: 2, delayMs: 2_000 });
    expect(nextSidecarRestart(3)).toEqual({ attempt: 3, delayMs: 4_000 });
    expect(nextSidecarRestart(4)).toBeNull();
  });

  it("parses sidecar data-dir arguments independent of Python executable", () => {
    expect(
      sidecarCommandLineDataDirs(
        '"C:\\Program Files\\Python311\\python.exe" -m photodedup.server --data-dir "C:\\Users\\lisyo\\.local\\share\\photo-dedup-desktop"'
      )
    ).toEqual(["C:\\Users\\lisyo\\.local\\share\\photo-dedup-desktop"]);
    expect(
      sidecarCommandLineDataDirs(
        "C:\\Python311\\python.exe -m photodedup.server --data-dir=C:\\Users\\lisyo\\.local\\share\\photo-dedup-desktop"
      )
    ).toEqual(["C:\\Users\\lisyo\\.local\\share\\photo-dedup-desktop"]);
  });
});
