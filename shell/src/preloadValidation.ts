import type { RendererSidecar, RendererUpdateStatus, RendererUpdateProgress } from "./preloadTypes";

export function validateSidecarInfo(info: unknown): RendererSidecar | null {
  if (typeof info !== "object" || info === null) {
    return null;
  }
  const candidate = info as Partial<RendererSidecar>;
  if (!Number.isInteger(candidate.port) || typeof candidate.token !== "string") {
    return null;
  }
  return { port: Number(candidate.port), token: candidate.token };
}

export function validateTrayScanNowCallback(callback: unknown): (() => void) | null {
  return typeof callback === "function" ? callback as () => void : null;
}

export function validateUpdateAvailability(info: unknown): RendererUpdateStatus | null {
  if (typeof info !== "object" || info === null) {
    return null;
  }
  const candidate = info as Partial<RendererUpdateStatus>;
  if (
    typeof candidate.current !== "string" ||
    (typeof candidate.latest !== "string" && candidate.latest !== null) ||
    (typeof candidate.htmlUrl !== "string" && candidate.htmlUrl !== null) ||
    typeof candidate.updateAvailable !== "boolean" ||
    typeof candidate.isSourceInstall !== "boolean"
  ) {
    return null;
  }
  if (candidate.updateAvailable && (typeof candidate.latest !== "string" || typeof candidate.htmlUrl !== "string")) {
    return null;
  }
  return {
    current: candidate.current,
    latest: candidate.latest ?? null,
    htmlUrl: candidate.htmlUrl ?? null,
    updateAvailable: candidate.updateAvailable,
    isSourceInstall: candidate.isSourceInstall,
  };
}

export function validateUpdateProgress(info: unknown): RendererUpdateProgress | null {
  if (typeof info !== "object" || info === null) {
    return null;
  }
  const candidate = info as Partial<RendererUpdateProgress>;
  if (
    candidate.status !== "running" &&
    candidate.status !== "succeeded" &&
    candidate.status !== "failed"
  ) {
    return null;
  }
  if (typeof candidate.stage !== "object" || candidate.stage === null) {
    return null;
  }
  if (typeof candidate.stage.id !== "string" || typeof candidate.stage.label !== "string") {
    return null;
  }
  return {
    status: candidate.status,
    stage: {
      id: candidate.stage.id,
      label: candidate.stage.label,
    },
    error: typeof candidate.error === "string" ? candidate.error : undefined,
    logPath: typeof candidate.logPath === "string" ? candidate.logPath : undefined,
  };
}
