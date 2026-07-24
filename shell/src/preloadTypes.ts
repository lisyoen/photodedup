export interface RendererSidecar {
  port: number;
  token: string;
}

export interface RendererUpdateStatus {
  current: string;
  latest: string | null;
  htmlUrl: string | null;
  updateAvailable: boolean;
  isSourceInstall: boolean;
}

export interface RendererUpdateProgress {
  status: "running" | "succeeded" | "failed";
  stage: {
    id: string;
    label: string;
  };
  error?: string;
  logPath?: string;
}

export interface RendererShell {
  selectFolder(): Promise<string | null>;
  selectFolders(): Promise<string[]>;
  getAppVersion(): Promise<string>;
  getUpdateAvailability(): Promise<RendererUpdateStatus | null>;
  checkForUpdates(): Promise<RendererUpdateStatus | null>;
  openReleasePage(url: string): Promise<void>;
  startUpdate(): Promise<{ ok: boolean; error?: string }>;
  restartAfterUpdate(): Promise<void>;
  onTrayScanNow(callback: () => void): () => void;
  onUpdateAvailable(callback: (update: RendererUpdateStatus) => void): () => void;
  onUpdateProgress(callback: (progress: RendererUpdateProgress) => void): () => void;
}
