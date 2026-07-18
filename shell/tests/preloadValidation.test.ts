import { describe, expect, it } from "vitest";
import { validateSidecarInfo } from "../src/preloadValidation";

describe("validateSidecarInfo", () => {
  it("accepts valid sidecar info", () => {
    expect(validateSidecarInfo({ port: 49152, token: "secret-token" })).toEqual({
      port: 49152,
      token: "secret-token",
    });
  });

  it("rejects missing fields", () => {
    expect(validateSidecarInfo({ port: 49152 })).toBeNull();
  });

  it("rejects null", () => {
    expect(validateSidecarInfo(null)).toBeNull();
  });
});
