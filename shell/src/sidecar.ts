import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface SidecarHandshake {
  port: number;
  token: string;
}

export interface SidecarManagerOptions {
  mode?: "dev" | "prod";
  projectRoot?: string;
  dataDir?: string;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  prodExecutablePath?: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  maxBufferedLogLines?: number;
}

export interface SidecarExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RestartDecision {
  attempt: number;
  delayMs: number;
}

type SidecarEvents = "early-exit" | "crash" | "exit";
type SidecarEvent = SidecarEvents | "log" | "spawn";
type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;
interface WindowsProcessRow {
  ProcessId?: unknown;
  CommandLine?: unknown;
}
interface ExecFileSyncError extends Error {
  status?: number;
  code?: string;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const SHELL_LOG_HINT = "~/.local/share/photo-dedup-desktop/shell.log";
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_LOG_LINES = 500;
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000];

export interface ResolveSidecarCommandOptions {
  mode: "dev" | "prod";
  projectRoot: string;
  dataDir: string;
  platform: NodeJS.Platform;
  prodExecutablePath?: string;
  resourcesPath?: string;
}

export function resolveSidecarCommand(options: ResolveSidecarCommandOptions): { executable: string; args: string[]; cwd: string } {
  if (options.mode === "prod") {
    const executableName = options.platform === "win32" ? "photodedup-sidecar.exe" : "photodedup-sidecar";
    const executable =
      options.prodExecutablePath ??
      path.join(options.resourcesPath ?? path.join(options.projectRoot, "resources"), "sidecar", options.platform, "photodedup-sidecar", executableName);
    return {
      executable,
      args: ["--data-dir", options.dataDir],
      cwd: options.resourcesPath ?? options.projectRoot,
    };
  }

  const executable =
    options.platform === "win32"
      ? path.join(options.projectRoot, "engine", ".venv", "Scripts", "python.exe")
      : path.join(options.projectRoot, "engine", ".venv", "bin", "python");

  return {
    executable,
    args: ["-m", "photodedup.server", "--data-dir", options.dataDir],
    cwd: path.join(options.projectRoot, "engine"),
  };
}

export function nextSidecarRestart(crashCount: number, maxRestarts = 3): RestartDecision | null {
  if (crashCount < 1 || crashCount > maxRestarts) {
    return null;
  }
  return {
    attempt: crashCount,
    delayMs: RESTART_BACKOFF_MS[Math.min(crashCount - 1, RESTART_BACKOFF_MS.length - 1)],
  };
}

export class SidecarManager extends EventEmitter {
  private child: ManagedChild | null = null;
  private startPromise: Promise<SidecarHandshake> | null = null;
  private handshake: SidecarHandshake | null = null;
  private stopping = false;
  private logLines: string[] = [];

  constructor(private readonly options: SidecarManagerOptions = {}) {
    super();
  }

  override on(event: SidecarEvents, listener: (exit: SidecarExit) => void): this;
  override on(event: "log" | "spawn", listener: (line: string) => void): this;
  override on(event: SidecarEvent, listener: ((exit: SidecarExit) => void) | ((line: string) => void)): this {
    return super.on(event, listener);
  }

  override emit(event: SidecarEvents, exit: SidecarExit): boolean;
  override emit(event: "log" | "spawn", line: string): boolean;
  override emit(event: SidecarEvent, payload: SidecarExit | string): boolean {
    return super.emit(event, payload);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  get bufferedLogs(): readonly string[] {
    return this.logLines;
  }

  async start(): Promise<SidecarHandshake> {
    if (this.handshake && this.isRunning) {
      return this.handshake;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.stopping = false;
    const command = this.resolveCommand();
    this.cleanupExistingSidecars();
    this.dumpSpawnEnvironment();
    this.emit("spawn", command.executable);
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.writePidFile(child.pid, command.executable);

    this.startPromise = new Promise<SidecarHandshake>((resolve, reject) => {
      let settled = false;
      let stdoutRemainder = "";

      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout.off("data", onStdoutData);
        child.stderr.off("data", onStderrData);
        child.off("error", onError);
        child.off("exit", onExitBeforeHandshake);
      };

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.startPromise = null;
        this.killChild("SIGTERM");
        reject(error);
      };

      const succeed = (value: SidecarHandshake) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.handshake = value;
        this.attachPostHandshakeLogging(child, stdoutRemainder);
        this.attachExitEvents(child);
        resolve(value);
      };

      const timeout = setTimeout(() => {
        fail(new Error(
          `sidecar did not report readiness within ${this.readyTimeoutMs}ms\n` +
          `Check the shell log for startup details: ${SHELL_LOG_HINT}`
        ));
      }, this.readyTimeoutMs);

      const onError = (error: Error) => fail(error);

      const onExitBeforeHandshake = (code: number | null, signal: NodeJS.Signals | null) => {
        const exit = { code, signal };
        this.emit("early-exit", exit);
        fail(new Error(`sidecar exited before handshake: code=${code} signal=${signal}`));
      };

      const onStderrData = (chunk: Buffer) => {
        this.bufferLog(chunk.toString("utf8"), "[sidecar:stderr] ");
      };

      const onStdoutData = (chunk: Buffer) => {
        stdoutRemainder += chunk.toString("utf8");
        const newlineIndex = stdoutRemainder.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }

        const line = stdoutRemainder.slice(0, newlineIndex).trim();
        stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          fail(new Error(`invalid sidecar handshake JSON: ${line}`));
          return;
        }
        if (!isHandshake(parsed)) {
          fail(new Error(`invalid sidecar handshake shape: ${line}`));
          return;
        }
        succeed(parsed);
      };

      child.once("error", onError);
      child.once("exit", onExitBeforeHandshake);
      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);
    });

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.stopping = true;
    this.handshake = null;
    this.startPromise = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.killChild("SIGKILL");
      }, this.stopTimeoutMs);

      child.once("exit", () => {
        clearTimeout(timeout);
        this.child = null;
        resolve();
      });

      this.killChild("SIGTERM");
    });
  }

  private attachPostHandshakeLogging(child: ManagedChild, initialStdout: string): void {
    if (initialStdout.length > 0) {
      this.bufferLog(initialStdout);
    }

    const stdoutReader = createInterface({ input: child.stdout });
    const stderrReader = createInterface({ input: child.stderr });
    stdoutReader.on("line", (line) => this.bufferLog(line));
    stderrReader.on("line", (line) => this.bufferLog(line, "[sidecar:stderr] "));
    child.once("exit", () => {
      stdoutReader.close();
      stderrReader.close();
    });
  }

  private attachExitEvents(child: ManagedChild): void {
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      const exit = { code, signal };
      this.removePidFile(child.pid);
      this.child = null;
      this.handshake = null;
      if (this.stopping) {
        this.emit("exit", exit);
      } else {
        this.emit("crash", exit);
      }
    });
  }

  private resolveCommand(): { executable: string; args: string[]; cwd: string } {
    return resolveSidecarCommand({
      mode: this.options.mode ?? (process.env.NODE_ENV === "production" ? "prod" : "dev"),
      projectRoot: this.projectRoot,
      dataDir: this.dataDir,
      platform: this.options.platform ?? process.platform,
      prodExecutablePath: this.options.prodExecutablePath,
      resourcesPath: this.options.resourcesPath,
    });
  }

  private get projectRoot(): string {
    if (this.options.projectRoot) {
      return path.resolve(this.options.projectRoot);
    }
    return path.basename(process.cwd()) === "shell" ? path.resolve(process.cwd(), "..") : process.cwd();
  }

  private get dataDir(): string {
    return this.options.dataDir ?? path.join(os.homedir(), ".local", "share", "photo-dedup-desktop");
  }

  private get readyTimeoutMs(): number {
    return this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  private get stopTimeoutMs(): number {
    return this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  private killChild(signal: NodeJS.Signals): void {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }

  private cleanupExistingSidecars(): void {
    const dataDir = path.resolve(this.dataDir);
    const seen = new Set<number>();
    for (const pid of this.readPidFileCandidates(dataDir)) {
      seen.add(pid);
      this.terminateExistingSidecar(pid, "pid file");
    }
    if (process.platform !== "win32") {
      return;
    }
    for (const pid of this.findWindowsSidecars(dataDir)) {
      if (pid !== process.pid && !seen.has(pid)) {
        this.terminateExistingSidecar(pid, "process list");
      }
    }
  }

  private readPidFileCandidates(dataDir: string): number[] {
    try {
      const raw = fs.readFileSync(this.pidFilePath, "utf8");
      const payload = JSON.parse(raw) as { pid?: unknown; dataDir?: unknown };
      if (typeof payload.pid !== "number" || !Number.isInteger(payload.pid) || payload.pid <= 0) {
        return [];
      }
      if (typeof payload.dataDir === "string" && path.resolve(payload.dataDir) === dataDir) {
        return [payload.pid];
      }
    } catch {
      return [];
    }
    return [];
  }

  private findWindowsSidecars(dataDir: string): number[] {
    const script = [
      "Get-CimInstance Win32_Process |",
      "Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains('photodedup.server') -and $_.CommandLine.ToLowerInvariant().Contains('--data-dir') } |",
      "Select-Object ProcessId,CommandLine |",
      "ConvertTo-Json -Compress",
    ].join(" ");
    try {
      const output = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      }).trim();
      if (!output) {
        return [];
      }
      const parsed = JSON.parse(output) as unknown;
      return (Array.isArray(parsed) ? parsed : [parsed])
        .map((row) => this.windowsProcessIdForDataDir(row, dataDir))
        .filter((pid): pid is number => Number.isInteger(pid));
    } catch (error) {
      this.bufferLog(`sidecar process scan failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private windowsProcessIdForDataDir(row: unknown, dataDir: string): number | null {
    if (typeof row !== "object" || row === null) {
      return null;
    }
    const processRow = row as WindowsProcessRow;
    if (!Number.isInteger(processRow.ProcessId) || typeof processRow.CommandLine !== "string") {
      return null;
    }
    return this.isMatchingSidecarCommandLine(processRow.CommandLine, dataDir) ? Number(processRow.ProcessId) : null;
  }

  private isMatchingSidecarCommandLine(commandLine: string, dataDir: string): boolean {
    const lowered = commandLine.toLowerCase();
    if (!lowered.includes("photodedup.server") || !lowered.includes("--data-dir")) {
      return false;
    }
    return sidecarCommandLineDataDirs(commandLine).some((candidate) => normalizeWindowsPath(candidate) === normalizeWindowsPath(dataDir));
  }

  private terminateExistingSidecar(pid: number, source: string): void {
    if (pid === process.pid) {
      return;
    }
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 5_000,
        });
      } else {
        process.kill(pid, "SIGTERM");
      }
      this.bufferLog(`terminated existing sidecar pid=${pid} source=${source}`);
    } catch (error) {
      const { code, status } = error as ExecFileSyncError;
      if (process.platform === "win32" && status === 128) {
        this.bufferLog(`stale sidecar pid=${pid} already gone`);
        return;
      }
      if (code !== "ESRCH") {
        this.bufferLog(`failed to terminate existing sidecar pid=${pid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private writePidFile(pid: number | undefined, executable: string): void {
    if (!pid) {
      return;
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.pidFilePath,
        `${JSON.stringify({ pid, dataDir: path.resolve(this.dataDir), executable, startedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      this.bufferLog(`sidecar pid file write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private removePidFile(pid: number | undefined): void {
    if (!pid) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.pidFilePath, "utf8");
      const payload = JSON.parse(raw) as { pid?: unknown };
      if (payload.pid === pid) {
        fs.unlinkSync(this.pidFilePath);
      }
    } catch {
      return;
    }
  }

  private dumpSpawnEnvironment(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, "sidecar-env.json"), `${JSON.stringify(process.env, null, 2)}\n`, "utf8");
    } catch (error) {
      this.bufferLog(`sidecar env dump failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private get pidFilePath(): string {
    return path.join(this.dataDir, "sidecar.pid");
  }

  private bufferLog(text: string, prefix = ""): void {
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => `${prefix}${line}`);
    this.logLines.push(...lines);
    for (const line of lines) {
      this.emit("log", line);
    }
    const maxLines = this.options.maxBufferedLogLines ?? DEFAULT_LOG_LINES;
    if (this.logLines.length > maxLines) {
      this.logLines.splice(0, this.logLines.length - maxLines);
    }
  }
}

export function sidecarCommandLineDataDirs(commandLine: string): string[] {
  const matches: string[] = [];
  const pattern = /--data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi;
  for (const match of commandLine.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) {
      matches.push(value);
    }
  }
  return matches;
}

function normalizeWindowsPath(value: string): string {
  return path.win32.normalize(value).replace(/\\+$/, "").toLowerCase();
}

function isHandshake(value: unknown): value is SidecarHandshake {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<SidecarHandshake>;
  return Number.isInteger(candidate.port) && Number(candidate.port) > 0 && typeof candidate.token === "string" && candidate.token.length > 0;
}
