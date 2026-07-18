import path from "node:path";
import { describe, expect, it } from "vitest";
import { rendererIndexPath } from "../src/paths";

describe("rendererIndexPath", () => {
  it("uses renderer dist beside the repo in dev", () => {
    expect(
      rendererIndexPath({
        packaged: false,
        resourcesPath: "/ignored",
        appDirname: path.join("/repo", "shell", "dist"),
      })
    ).toBe(path.join("/repo", "renderer", "dist", "index.html"));
  });

  it("uses extraResources renderer output in packaged builds", () => {
    expect(
      rendererIndexPath({
        packaged: true,
        resourcesPath: "/opt/PhotoDedup/resources",
        appDirname: "/opt/PhotoDedup/resources/app.asar/dist",
      })
    ).toBe(path.join("/opt/PhotoDedup/resources", "renderer", "index.html"));
  });
});
