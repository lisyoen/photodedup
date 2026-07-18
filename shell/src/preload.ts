import { contextBridge, ipcRenderer } from "electron";

interface RendererSidecar {
  port: number;
  token: string;
}

interface RendererShell {
  selectFolder(): Promise<string | null>;
  selectFolders(): Promise<string[]>;
  onTrayScanNow(callback: () => void): () => void;
}

declare global {
  interface Window {
    sidecar?: RendererSidecar;
    shell: RendererShell;
  }
}

function validateSidecarInfo(info: unknown): RendererSidecar | null {
  if (typeof info !== "object" || info === null) {
    return null;
  }
  const candidate = info as Partial<RendererSidecar>;
  if (!Number.isInteger(candidate.port) || typeof candidate.token !== "string") {
    return null;
  }
  return { port: Number(candidate.port), token: candidate.token };
}

function validateTrayScanNowCallback(callback: unknown): (() => void) | null {
  return typeof callback === "function" ? callback as () => void : null;
}

function validateFolderPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0);
}

const sidecar = validateSidecarInfo(ipcRenderer.sendSync("sidecar-info") as unknown);

if (sidecar) {
  contextBridge.exposeInMainWorld("sidecar", sidecar);
} else {
  console.error("Invalid or missing sidecar info from main process.");
}

contextBridge.exposeInMainWorld("shell", {
  selectFolder: () => ipcRenderer.invoke("select-folder") as Promise<string | null>,
  selectFolders: async () => validateFolderPaths(await ipcRenderer.invoke("dialog:selectFolders")),
  onTrayScanNow: (callback) => {
    const validated = validateTrayScanNowCallback(callback);
    if (!validated) return () => undefined;
    const listener = () => validated();
    ipcRenderer.on("tray:scan-now", listener);
    return () => ipcRenderer.removeListener("tray:scan-now", listener);
  },
} satisfies RendererShell);
