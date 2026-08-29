import { describe, expect, it } from "vitest";
import {
  resolveDurableFeedFileDefinition,
  resolveExpectedFeedCurrency,
} from "../src/exporters/durable-feed-file-definition";

describe("durable feed file definition", () => {
  it("resolves Google market and language files without changing public paths", () => {
    expect(resolveDurableFeedFileDefinition({
      channel: "google",
      fileKey: "google-market-CH_DE",
      version: "v1",
      language: "de",
      marketCode: "CH_DE",
    })).toMatchObject({
      currentPath: "feeds/google/google-de-CH_DE.tsv",
      versionedPath: "feeds/google/versions/v1/google-de-CH_DE.tsv",
      delimiter: "\t",
      expectedCurrencyMarket: "CH_DE",
    });
    expect(resolveDurableFeedFileDefinition({
      channel: "google",
      fileKey: "google-language-fr",
      version: "v1",
      language: "fr",
      marketCode: "LANG_FR",
    })).toMatchObject({
      currentPath: "feeds/google/google-fr.tsv",
      expectedCurrencyMarket: null,
    });
  });

  it("resolves Meta physical layers with their existing filenames", () => {
    expect(resolveDurableFeedFileDefinition({
      channel: "meta",
      fileKey: "meta-country-CH",
      version: "v1",
      language: "",
      marketCode: "CH",
    })).toMatchObject({
      currentPath: "feeds/meta/meta-country-CH.csv",
      versionedPath: "feeds/meta/versions/v1/meta-country-CH.csv",
      delimiter: ",",
      expectedCurrencyMarket: "CH",
    });
  });

  it("requires one identical configured currency across a shared country layer", () => {
    const markets = {
      CH_DE: { currency: "CHF" },
      CH_FR: { currency: "CHF" },
      BE_FR: { currency: "EUR" },
    };
    expect(resolveExpectedFeedCurrency(markets, ["CH_DE", "CH_FR"])).toBe("CHF");
    expect(() => resolveExpectedFeedCurrency(
      { CH_DE: { currency: "CHF" }, CH_FR: { currency: "EUR" } },
      ["CH_DE", "CH_FR"],
    )).toThrow("Conflicting configured currencies");
  });
});