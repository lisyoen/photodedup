import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("preload bundle", () => {
  it("is emitted as a single preload file without local module requires", () => {
    const preloadPath = path.resolve(__dirname, "..", "dist", "preload.js");

    if (!existsSync(preloadPath)) {
      throw new Error(`Missing ${preloadPath}. Run npm run build before running shell tests.`);
    }

    const preloadSource = readFileSync(preloadPath, "utf8");

    expect(preloadSource).not.toContain('require("./preloadValidation")');
    expect(preloadSource).not.toContain('require("./preloadTypes")');
    expect(preloadSource).toContain("contextBridge");
  });
});
