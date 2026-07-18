export interface RendererSidecar {
  port: number;
  token: string;
}

export interface RendererShell {
  selectFolder(): Promise<string | null>;
  selectFolders(): Promise<string[]>;
  onTrayScanNow(callback: () => void): () => void;
}
