import { describe, expect, it, vi } from "vitest";
import { openAllowedExternalUrl } from "../src/externalLinks";

describe("openAllowedExternalUrl", () => {
  it("opens only URLs under the PhotoDedup GitHub repository", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);

    await openAllowedExternalUrl(
      "https://github.com/lisyoen/photodedup/releases/tag/v0.1.6",
      openExternal
    );
    await openAllowedExternalUrl("https://example.com/phishing", openExternal);
    await openAllowedExternalUrl("https://github.com/lisyoen/photodedup-malicious/releases", openExternal);

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/lisyoen/photodedup/releases/tag/v0.1.6"
    );
  });
});
