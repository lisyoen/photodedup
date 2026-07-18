import { describe, expect, it } from "vitest";
import { validateSidecarInfo, validateUpdateAvailability } from "../src/preloadValidation";

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

describe("validateUpdateAvailability", () => {
  it("accepts available update status", () => {
    expect(validateUpdateAvailability({
      current: "0.1.1",
      latest: "0.1.2",
      htmlUrl: "https://github.com/lisyoen/photodedup/releases/tag/v0.1.2",
      updateAvailable: true,
      isSourceInstall: true,
    })).toEqual({
      current: "0.1.1",
      latest: "0.1.2",
      htmlUrl: "https://github.com/lisyoen/photodedup/releases/tag/v0.1.2",
      updateAvailable: true,
      isSourceInstall: true,
    });
  });

  it("accepts failed lookup status", () => {
    expect(validateUpdateAvailability({
      current: "0.1.1",
      latest: null,
      htmlUrl: null,
      updateAvailable: false,
      isSourceInstall: true,
    })).toEqual({
      current: "0.1.1",
      latest: null,
      htmlUrl: null,
      updateAvailable: false,
      isSourceInstall: true,
    });
  });

  it("rejects available status without a release URL", () => {
    expect(validateUpdateAvailability({
      current: "0.1.1",
      latest: "0.1.2",
      htmlUrl: null,
      updateAvailable: true,
      isSourceInstall: true,
    })).toBeNull();
  });
});
