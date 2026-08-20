import { describe, expect, it } from "vitest";
import {
  META_LANGUAGE_FEED_HEADERS,
  serializeMetaLanguageRows,
} from "../src/exporters/meta/language-feeds";

describe("public Meta language feed serialization", () => {
  it("uses the flat public-feed contract and has stable bytes regardless of source order", () => {
    const marketRows = [
      {
        id: "variant-b",
        item_group_id: "product-b",
        title: "Sofa DE",
        description: "Description DE",
        link: "https://example.test/de/sofa-b",
        price: "1200 EUR",
        availability: "in stock",
        shipping: "DE::Standard:49 EUR",
      },
      {
        id: "variant-a",
        item_group_id: "product-a",
        title: "Canapé FR",
        description: "Description FR",
        link: "https://example.test/fr/canape-a",
        price: "1100 EUR",
        availability: "in stock",
        shipping: "FR::Standard:39 EUR",
      },
    ];

    const forward = serializeMetaLanguageRows(marketRows);
    const reversed = serializeMetaLanguageRows([...marketRows].reverse());

    expect(forward.itemCount).toBe(2);
    expect(forward.csv).toBe(reversed.csv);
    expect(forward.csv.split("\n")[0]).toBe(META_LANGUAGE_FEED_HEADERS.join(","));
    expect(forward.csv).toContain("variant-a");
    expect(forward.csv).toContain("variant-b");
    expect(forward.csv.indexOf("variant-a")).toBeLessThan(forward.csv.indexOf("variant-b"));
  });
});