import { describe, expect, it } from "vitest";
import en from "./en";
import ja from "./ja";
import ko from "./ko";
import { LANGUAGES } from "./languages";

describe("i18n dictionaries", () => {
  it("keeps locale keys in parity", () => {
    for (const [locale, dictionary] of Object.entries({ ko, ja })) {
      expect(Object.keys(dictionary).sort(), `${locale} keys`).toEqual(Object.keys(en).sort());
    }
  });

  it("does not contain empty translation values", () => {
    for (const [locale, dictionary] of Object.entries({ en, ko, ja })) {
      const emptyKeys = Object.entries(dictionary)
        .filter(([, value]) => value.trim().length === 0)
        .map(([key]) => key);

      expect(emptyKeys, `${locale} empty keys`).toEqual([]);
    }
  });

  it("includes startup folder and empty group UI keys in every locale", () => {
    for (const [locale, dictionary] of Object.entries({ en, ko, ja })) {
      expect(dictionary["app.selectFolder"], `${locale} app.selectFolder`).toBeTruthy();
      expect(dictionary["groups.empty"], `${locale} groups.empty`).toBeTruthy();
    }
  });

  it("uses the public product name as the app title in every locale", () => {
    for (const [locale, dictionary] of Object.entries({ en, ko, ja })) {
      expect(dictionary["app.title"], `${locale} app.title`).toBe("PhotoDedup");
    }
  });

  it("exposes native language labels", () => {
    expect(LANGUAGES).toEqual([
      { code: "en", label: "English" },
      { code: "ko", label: "한국어" },
      { code: "ja", label: "日本語" }
    ]);
  });
});
