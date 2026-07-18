import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ReleaseInfo {
  tag_name?: unknown;
  html_url?: unknown;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  htmlUrl: string | null;
  updateAvailable: boolean;
  isSourceInstall: boolean;
}

export interface UpdateAvailability {
  current: string;
  latest: string;
  htmlUrl: string;
  updateAvailable: true;
  isSourceInstall: boolean;
}

export type UpdateStageId = "git-pull" | "renderer-install" | "renderer-build" | "shell-install" | "shell-build";

export interface UpdateStage {
  id: UpdateStageId;
  label: string;
}

export interface UpdateProgress {
  status: "running" | "succeeded" | "failed";
  stage: UpdateStage;
  error?: string;
  logPath?: string;
}

export const UPDATE_STAGES: UpdateStage[] = [
  { id: "git-pull", label: "git pull origin main" },
  { id: "renderer-install", label: "renderer: npm install --no-audit --no-fund" },
  { id: "renderer-build", label: "renderer: npm run build" },
  { id: "shell-install", label: "shell: npm install --no-audit --no-fund" },
  { id: "shell-build", label: "shell: npm run build" },
];

export function normalizeSemver(version: string): [number, number, number] | null {
  const trimmed = version.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(left: string, right: string): number | null {
  const leftParts = normalizeSemver(left);
  const rightParts = normalizeSemver(right);
  if (!leftParts || !rightParts) {
    return null;
  }

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function resolveUpdateAvailability(
  release: ReleaseInfo,
  currentVersion: string,
  isSourceInstall: boolean
): UpdateAvailability | null {
  const status = resolveUpdateStatus(release, currentVersion, isSourceInstall);
  if (!status.updateAvailable || status.latest === null || status.htmlUrl === null) {
    return null;
  }

  return {
    current: status.current,
    latest: status.latest,
    htmlUrl: status.htmlUrl,
    updateAvailable: true,
    isSourceInstall: status.isSourceInstall,
  };
}

export function resolveUpdateStatus(
  release: ReleaseInfo,
  currentVersion: string,
  isSourceInstall: boolean
): UpdateStatus {
  if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") {
    return {
      current: currentVersion,
      latest: null,
      htmlUrl: null,
      updateAvailable: false,
      isSourceInstall,
    };
  }

  const latest = release.tag_name.trim().replace(/^v/i, "");
  const comparison = compareSemver(latest, currentVersion);
  return {
    current: currentVersion,
    latest,
    htmlUrl: release.html_url,
    updateAvailable: comparison !== null && comparison > 0,
    isSourceInstall,
  };
}

export function isSourceInstall(repoRoot: string, packaged: boolean): boolean {
  return !packaged && fs.existsSync(path.join(repoRoot, ".git"));
}

export async function fetchLatestRelease(
  fetchImpl: typeof fetch,
  timeoutMs = 5000
): Promise<ReleaseInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("https://api.github.com/repos/lisyoen/photodedup/releases/latest", {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "PhotoDedup-update-check",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }
    return await response.json() as ReleaseInfo;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkUpdateAvailability(options: {
  currentVersion: string;
  isSourceInstall: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<UpdateAvailability | null> {
  const status = await checkUpdateStatus(options);
  return status.updateAvailable && status.latest !== null && status.htmlUrl !== null
    ? {
      current: status.current,
      latest: status.latest,
      htmlUrl: status.htmlUrl,
      updateAvailable: true,
      isSourceInstall: status.isSourceInstall,
    }
    : null;
}

export async function checkUpdateStatus(options: {
  currentVersion: string;
  isSourceInstall: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<UpdateStatus> {
  const release = await fetchLatestRelease(options.fetchImpl ?? fetch, options.timeoutMs);
  if (!release) {
    return {
      current: options.currentVersion,
      latest: null,
      htmlUrl: null,
      updateAvailable: false,
      isSourceInstall: options.isSourceInstall,
    };
  }
  return resolveUpdateStatus(release, options.currentVersion, options.isSourceInstall);
}

export async function runSourceUpdate(options: {
  repoRoot: string;
  log: (message: string) => void;
  onProgress: (progress: UpdateProgress) => void;
}): Promise<{ ok: true } | { ok: false; stage: UpdateStage; error: string }> {
  const commands: Array<{ stage: UpdateStage; command: string; args: string[]; cwd?: string }> = [
    { stage: UPDATE_STAGES[0], command: "git", args: ["pull", "origin", "main"] },
    { stage: UPDATE_STAGES[1], command: "npm", args: ["install", "--no-audit", "--no-fund"], cwd: "renderer" },
    { stage: UPDATE_STAGES[2], command: "npm", args: ["run", "build"], cwd: "renderer" },
    { stage: UPDATE_STAGES[3], command: "npm", args: ["install", "--no-audit", "--no-fund"], cwd: "shell" },
    { stage: UPDATE_STAGES[4], command: "npm", args: ["run", "build"], cwd: "shell" },
  ];

  for (const { stage, command, args, cwd } of commands) {
    options.onProgress({ status: "running", stage });
    const commandCwd = cwd ? path.join(options.repoRoot, cwd) : options.repoRoot;
    const result = await runCommand(command, args, commandCwd, options.log);
    if (!result.ok) {
      options.onProgress({ status: "failed", stage, error: result.error });
      return { ok: false, stage, error: result.error };
    }
  }

  const finalStage = UPDATE_STAGES[UPDATE_STAGES.length - 1];
  options.onProgress({ status: "succeeded", stage: finalStage });
  return { ok: true };
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  log: (message: string) => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: process.platform === "win32" });
    log(`update command start: ${command} ${args.join(" ")}`);

    child.stdout.on("data", (chunk) => log(`update stdout: ${String(chunk).trimEnd()}`));
    child.stderr.on("data", (chunk) => log(`update stderr: ${String(chunk).trimEnd()}`));
    child.on("error", (error) => {
      log(`update command error: ${error.message}`);
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        log(`update command success: ${command} ${args.join(" ")}`);
        resolve({ ok: true });
        return;
      }
      const error = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      log(`update command failed: ${command} ${args.join(" ")} ${error}`);
      resolve({ ok: false, error });
    });
  });
}
