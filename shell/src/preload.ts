import { contextBridge, ipcRenderer } from "electron";
import {
  validateSidecarInfo,
  validateTrayScanNowCallback,
  validateUpdateAvailability,
  validateUpdateProgress
} from "./preloadValidation";
import type { RendererShell, RendererSidecar } from "./preloadTypes";

declare global {
  interface Window {
    sidecar?: RendererSidecar;
    shell: RendererShell;
  }
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
  getAppVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>,
  getUpdateAvailability: async () => validateUpdateAvailability(await ipcRenderer.invoke("update:get-availability")),
  openReleasePage: (url) => ipcRenderer.invoke("update:open-release-page", url) as Promise<void>,
  startUpdate: () => ipcRenderer.invoke("update:start") as Promise<{ ok: boolean; error?: string }>,
  restartAfterUpdate: () => ipcRenderer.invoke("update:restart") as Promise<void>,
  onTrayScanNow: (callback) => {
    const validated = validateTrayScanNowCallback(callback);
    if (!validated) return () => undefined;
    const listener = () => validated();
    ipcRenderer.on("tray:scan-now", listener);
    return () => ipcRenderer.removeListener("tray:scan-now", listener);
  },
  onUpdateAvailable: (callback) => {
    if (typeof callback !== "function") return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, update: unknown) => {
      const validated = validateUpdateAvailability(update);
      if (validated) callback(validated);
    };
    ipcRenderer.on("update:available", listener);
    return () => ipcRenderer.removeListener("update:available", listener);
  },
  onUpdateProgress: (callback) => {
    if (typeof callback !== "function") return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => {
      const validated = validateUpdateProgress(progress);
      if (validated) callback(validated);
    };
    ipcRenderer.on("update:progress", listener);
    return () => ipcRenderer.removeListener("update:progress", listener);
  },
} satisfies RendererShell);
