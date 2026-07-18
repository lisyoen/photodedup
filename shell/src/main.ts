import { app, BrowserWindow, Menu, Tray, dialog, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rendererIndexPath } from "./paths";
import { nextSidecarRestart, SidecarManager, type SidecarHandshake } from "./sidecar";

let mainWindow: BrowserWindow | null = null;
let mainWindowCreation: Promise<void> | null = null;
let tray: Tray | null = null;
let sidecarInfo: SidecarHandshake | null = null;
const sidecar = new SidecarManager({
  mode: app.isPackaged ? "prod" : "dev",
  resourcesPath: process.resourcesPath,
});
const dataDir = path.join(os.homedir(), ".local", "share", "photo-dedup-desktop");
const shellLogPath = path.join(dataDir, "shell.log");
let appExitLogged = false;
let isQuitting = false;
let sidecarStopRequested = false;
let sidecarCrashCount = 0;
let sidecarRestartTimer: NodeJS.Timeout | null = null;

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

function appendShellLog(message: string): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(shellLogPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch (error) {
    console.error("failed to write shell log", error);
  }
}

function logAppExitOnce(): void {
  if (appExitLogged) {
    return;
  }
  appExitLogged = true;
  appendShellLog("app exit");
}

function recentSidecarLogs(): string {
  const logs = sidecar.bufferedLogs.slice(-20);
  return logs.length > 0 ? logs.join("\n") : "(no sidecar logs buffered)";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function showSidecarFailure(title: string, message: string): void {
  const detail = `${message}\n--- 최근 로그 ---\n${recentSidecarLogs()}`;
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showMessageBoxSync(mainWindow, {
      type: "error",
      title,
      message: title,
      detail,
    });
  } else {
    dialog.showErrorBox(title, detail);
  }
}

function clearSidecarRestartTimer(): void {
  if (sidecarRestartTimer) {
    clearTimeout(sidecarRestartTimer);
    sidecarRestartTimer = null;
  }
}

function scheduleSidecarRestart(reason: string): void {
  appendShellLog(reason);
  sidecarInfo = null;
  sidecarCrashCount += 1;
  const restart = nextSidecarRestart(sidecarCrashCount);
  if (!restart) {
    showSidecarFailure("사이드카 중단", `${reason}. 앱을 다시 시작해 주세요.`);
    app.exit(1);
    return;
  }

  appendShellLog(`sidecar restart scheduled attempt=${restart.attempt} delayMs=${restart.delayMs}`);
  clearSidecarRestartTimer();
  sidecarRestartTimer = setTimeout(() => {
    sidecarRestartTimer = null;
    appendShellLog(`sidecar restart attempt=${restart.attempt}`);
    sidecar
      .start()
      .then((info) => {
        sidecarInfo = info;
        appendShellLog(`sidecar restart success attempt=${restart.attempt} port=${info.port}`);
      })
      .catch((error) => {
        scheduleSidecarRestart(`sidecar restart failed attempt=${restart.attempt} ${formatError(error)}`);
      });
  }, restart.delayMs);
}

function trayIconPath(): string {
  return path.resolve(__dirname, "..", "assets", "tray.png");
}

function restoreMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void ensureMainWindow();
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
  appendShellLog("window restored");
}

function sendTrayScanNow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    appendShellLog("tray scan-now skipped no window");
    return;
  }
  mainWindow.webContents.send("tray:scan-now");
  appendShellLog("tray scan-now sent");
}

function createTray(): void {
  if (tray) {
    return;
  }

  tray = new Tray(trayIconPath());
  tray.setToolTip("Photo Dedup Desktop");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "열기", click: restoreMainWindow },
      { label: "지금 스캔", click: sendTrayScanNow },
      {
        label: "종료",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("double-click", restoreMainWindow);
  appendShellLog("tray created");
}

ipcMain.on("sidecar-info", (event) => {
  event.returnValue = sidecarInfo;
});

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });

  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle("dialog:selectFolders", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "multiSelections"],
  });

  return result.canceled ? [] : result.filePaths;
});

async function createMainWindow(): Promise<void> {
  if (!sidecar.isRunning) {
    sidecarInfo = await sidecar.start();
    sidecarCrashCount = 0;
    appendShellLog(`sidecar handshake success port=${sidecarInfo.port}`);
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    appendShellLog(`preload-error ${preloadPath} ${String(error)}`);
  });

  const rendererDist = rendererIndexPath({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDirname: __dirname,
  });
  await mainWindow.loadFile(rendererDist);
  mainWindow.on("close", () => {
    if (isQuitting) {
      return;
    }
    isQuitting = true;
    app.quit();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function ensureMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return Promise.resolve();
  }
  if (!mainWindowCreation) {
    mainWindowCreation = createMainWindow().finally(() => {
      mainWindowCreation = null;
    });
  }
  return mainWindowCreation;
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }

  appendShellLog("app start");
  sidecar.on("spawn", (executable) => {
    appendShellLog(`sidecar spawn executable=${executable}`);
  });
  sidecar.on("log", (line) => {
    appendShellLog(line.startsWith("[sidecar:stderr]") ? line : `sidecar log ${line}`);
  });
  sidecar.on("crash", (exit) => {
    scheduleSidecarRestart(`sidecar crash code=${exit.code} signal=${exit.signal}`);
  });

  ensureMainWindow().catch((error) => {
    showSidecarFailure("사이드카 시작 실패", formatError(error));
    app.exit(1);
  });
  createTray();
});

app.on("second-instance", () => {
  appendShellLog("second instance -> restore window");
  restoreMainWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  clearSidecarRestartTimer();
  logAppExitOnce();
  if (!sidecar.isRunning || sidecarStopRequested) {
    return;
  }
  event.preventDefault();
  sidecarStopRequested = true;
  appendShellLog("sidecar stop");
  void sidecar.stop().finally(() => app.exit(0));
});

export function getSidecarInfoForTests(): SidecarHandshake | null {
  return sidecarInfo;
}
