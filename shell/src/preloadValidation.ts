import type { RendererSidecar } from "./preloadTypes";

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
