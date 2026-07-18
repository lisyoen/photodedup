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
    const modalActionsRule = ruleFor(".modal-actions");

    expect(modalRule).toContain("max-height: calc(100vh - 40px)");
    expect(modalRule).toContain("display: flex");
    expect(modalRule).toContain("flex-direction: column");
    expect(modalRule).toContain("overflow: hidden");
    expect(modalBodyRule).toContain("flex: 1 1 auto");
    expect(modalBodyRule).toContain("min-height: 0");
    expect(modalBodyRule).toContain("overflow-y: auto");
    expect(modalBodyRule).toContain("overflow-x: hidden");
    expect(modalActionsRule).toContain("flex: 0 0 auto");
    expect(modalRule).not.toContain("overflow-y: auto");
    expect(modalActionsRule).not.toContain("overflow-y: auto");
  });

  it("widens the settings modal while keeping long settings content inside the body", () => {
    const settingsModalRule = ruleFor(".settings-modal");
    const folderAddRowRule = ruleFor(".folder-add-row");
    const folderListSpanRule = ruleFor(".folder-list span");
    const cachePathInputRule = ruleFor(".cache-path-row input");

    expect(settingsModalRule).toContain("width: min(760px, calc(100vw - 48px))");
    expect(folderAddRowRule).toContain("grid-template-columns: minmax(0, 1fr) auto auto");
    expect(folderAddRowRule).toContain("gap: 8px");
    expect(folderListSpanRule).toContain("min-width: 0");
    expect(folderListSpanRule).toContain("overflow-wrap: anywhere");
    expect(cachePathInputRule).toContain("min-width: 0");
    expect(cachePathInputRule).toContain("text-overflow: ellipsis");
  });
});
