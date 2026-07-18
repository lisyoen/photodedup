// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function ruleFor(selector) {
  return css.match(new RegExp(`${selector.replaceAll(".", "\\.")}\\s*\\{[^}]*\\}`))?.[0] ?? "";
}

function standaloneRuleFor(selector) {
  const matches = Array.from(css.matchAll(new RegExp(`(?:^|\\n)${selector.replaceAll(".", "\\.")}\\s*\\{[^}]*\\}`, "g")));
  return matches.at(-1)?.[0] ?? "";
}

function customPropertyValue(name) {
  const match = css.match(new RegExp(`${name}:\\s*(\\d+)\\s*;`));
  return match ? Number(match[1]) : Number.NaN;
}

describe("thumbnail image fit", () => {
  it("renders group and detail thumbnails without cropping portrait photos", () => {
    expect(css).toContain(".group-cover img");
    expect(css).toContain(".photo-card img");
    expect(css.match(/object-fit:\s*contain/g)).toHaveLength(2);
    expect(css.match(/background:\s*#171a21/g)?.length).toBeGreaterThanOrEqual(2);
    expect(css).not.toContain("object-fit: cover");
  });
});

describe("group list filters", () => {
  it("keeps filters pinned to the top of the scrolling group list", () => {
    const filtersRule = css.match(/\.group-list\s+\.filters\s*\{[^}]*\}/)?.[0] ?? "";

    expect(filtersRule).toContain("position: sticky");
    expect(filtersRule).toMatch(/top:\s*0\b/);
  });

  it("keeps modal overlays above sticky content layers", () => {
    const filtersRule = css.match(/\.group-list\s+\.filters\s*\{[^}]*\}/)?.[0] ?? "";
    const modalBackdropRule = ruleFor(".modal-backdrop");

    expect(filtersRule).toContain("z-index: var(--z-content-sticky)");
    expect(modalBackdropRule).toContain("z-index: var(--z-modal-backdrop)");
    expect(customPropertyValue("--z-modal-backdrop")).toBeGreaterThan(customPropertyValue("--z-content-sticky"));
  });

  it("keeps modal headers and actions fixed while only the body scrolls", () => {
    const modalRule = standaloneRuleFor(".modal");
    const modalBodyRule = standaloneRuleFor(".modal-body");

    expect(modalRule).toContain("max-height: calc(100vh - 40px)");
    expect(modalRule).toContain("grid-template-rows: auto minmax(0, 1fr) auto");
    expect(modalRule).toContain("overflow: hidden");
    expect(modalBodyRule).toContain("min-height: 0");
    expect(modalBodyRule).toContain("overflow-y: auto");
  });
});
