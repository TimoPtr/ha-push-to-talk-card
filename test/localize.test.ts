import { describe, expect, it } from "vitest";
import { localize, type TranslationKey } from "../src/localize";
import en from "../src/translations/en.json";
import fr from "../src/translations/fr.json";

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("localize", () => {
  it("returns the English text by default", () => {
    expect(localize(undefined, "button.talk")).toBe("Talk");
  });

  it("uses the user's language", () => {
    expect(localize({ locale: { language: "fr" } }, "button.talk")).toBe(
      fr["button.talk"],
    );
    expect(fr["button.talk"]).not.toBe(en["button.talk"]);
  });

  it("matches a regional language to its base language", () => {
    expect(localize({ locale: { language: "fr-CA" } }, "button.stop")).toBe(
      fr["button.stop"],
    );
  });

  it("falls back to English for an unknown language", () => {
    expect(localize({ locale: { language: "nl" } }, "button.stop")).toBe(
      "Stop",
    );
  });

  it("replaces placeholders", () => {
    expect(localize(undefined, "error.start_failed", { message: "boom" })).toBe(
      "Could not connect to the camera: boom",
    );
  });

  it("has the same keys in every language", () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps every placeholder in the French text", () => {
    for (const key of Object.keys(en) as TranslationKey[]) {
      expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]));
    }
  });
});
