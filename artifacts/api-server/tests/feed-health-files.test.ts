import { describe, expect, it } from "vitest";
import { publicFeedPathForSnapshot } from "../src/routes/feed-health";

const generatedAt = new Date("2026-08-28T12:00:00.000Z");

describe("publicFeedPathForSnapshot", () => {
  it.each([
    ["google", "fr", "LANG_FR", "feeds/google/google-fr.tsv", "/api/feeds/google/fr.tsv"],
    ["google", "fr", "BE_FR", "feeds/google/google-fr-BE_FR.tsv", "/api/feeds/google/market/BE_FR.tsv"],
    ["meta", null, null, "feeds/meta/meta-base.csv", "/api/feeds/meta/base.csv"],
    ["meta", "fr", "LANG_FR", "feeds/meta/meta-language-fr.csv", "/api/feeds/meta/lang/fr.csv"],
    ["meta", null, "BE", "feeds/meta/meta-country-BE.csv", "/api/feeds/meta/country/BE.csv"],
    ["showroom", "de", "EUPEN", "feeds/showroom/google-eupen.tsv", "/api/feeds/google/showroom/eupen.tsv"],
    ["showroom", "de", "EUPEN_META", "feeds/showroom/meta-eupen.csv", "/api/feeds/meta/showroom/eupen.csv"],
  ])("maps %s %s %s to its stable public route", (
    channel,
    language,
    marketCode,
    storagePath,
    expected,
  ) => {
    expect(publicFeedPathForSnapshot({
      channel: channel as string,
      language: language as string | null,
      marketCode: marketCode as string | null,
      storagePath: storagePath as string,
      itemCount: 1,
      generatedAt,
      sha256: "sha",
    })).toBe(expected);
  });
});