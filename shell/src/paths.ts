import path from "node:path";

export interface RendererIndexPathOptions {
  packaged: boolean;
  resourcesPath: string;
  appDirname: string;
}

export function rendererIndexPath(options: RendererIndexPathOptions): string {
  if (options.packaged) {
    return path.join(options.resourcesPath, "renderer", "index.html");
  }
  return path.resolve(options.appDirname, "..", "..", "renderer", "dist", "index.html");
}
