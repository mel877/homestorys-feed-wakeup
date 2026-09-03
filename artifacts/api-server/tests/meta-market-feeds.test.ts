import { describe, expect, it } from "vitest";
import {
  META_MARKET_FEED_HEADERS,
  META_MARKET_FEEDS,
  composeMetaMarketRows,
} from "../src/exporters/meta/market-feeds";

const base = (id: string) => ({
  id,
  item_group_id: "group-1",
  gtin: "1234567890123",
  mpn: "MPN-1",
  brand: "Homestorys",
  condition: "new",
  image_link: "https://example.com/main.jpg",
  additional_image_link: "",
  lifestyle_image_link: "",
  google_product_category: "Furniture",
  product_type: "Furniture > Sofas",
  color: "beige",
  material: "linen",
  age_group: "adult",
  gender: "unisex",
  return_policy_info: '{"is_final_sale":"false","return_policy_days":"14"}',
  custom_label_0: "",
  custom_label_1: "",
  custom_label_2: "",
  custom_label_3: "",
  custom_label_4: "",
});

const language = (id: string, title = "Canapé") => ({
  id,
  title,
  description: "Description",
  link: `https://example.com/${id}`,
});

const country = (
  id: string,
  currency = "EUR",
  price = "100.00",
  salePrice = "80.00",
) => ({
  id,
  price: `${price} ${currency}`,
  sale_price: salePrice ? `${salePrice} ${currency}` : "",
  sale_price_effective_date: "",
  availability: "in stock",
  shipping: `FR::Standard:9.50 ${currency}`,
});

describe("complete Meta market feed composition", () => {
  it.each([
    ["FR", "EUR", "https://shop-fr.homestorys.com/products/fauteuil?variant=201", "https://shop.homestorys.com/fr/products/fauteuil?variant=201"],
    ["BE_FR", "EUR", "https://shop-fr.homestorys.com/products/fauteuil?variant=202", "https://shop.homestorys.com/fr/products/fauteuil?variant=202"],
    ["DE", "EUR", "https://shop-de.homestorys.com/products/sessel?variant=203", "https://shop.homestorys.com/products/sessel?variant=203"],
    ["BE_DE", "EUR", "https://shop-de.homestorys.com/products/sessel?variant=204", "https://shop.homestorys.com/products/sessel?variant=204"],
    ["AT", "EUR", "https://shop-de.homestorys.com/products/sessel?variant=205", "https://shop.homestorys.com/products/sessel?variant=205"],
    ["LU_DE", "EUR", "https://shop-de.homestorys.com/products/sessel?variant=206", "https://shop.homestorys.com/products/sessel?variant=206"],
    ["CH_FR", "CHF", "https://shop.homestorys.com/fr-ch/products/fauteuil?variant=207", "https://shop.homestorys.com/fr-ch/products/fauteuil?variant=207"],
    ["CH_DE", "CHF", "https://shop.homestorys.com/de-ch/products/sessel?variant=208", "https://shop.homestorys.com/de-ch/products/sessel?variant=208"],
  ] as const)(
    "normalizes only the %s MARKET link and preserves every other Meta field",
    (marketCode, currency, sourceLink, expectedLink) => {
      const id = `variant-1_${marketCode}`;
      const languageRow = { ...language(id), link: sourceLink };
      const expectedWithoutNormalizedLink = {
        ...base(id),
        ...languageRow,
        ...country(id, currency),
      };
      const rows = composeMetaMarketRows({
        marketCode,
        expectedCurrency: currency,
        baseRows: [base(id)],
        languageRows: [languageRow],
        countryRows: [country(id, currency)],
      });
      const { link, ...actualWithoutLink } = rows[0]!;
      const { link: originalLink, ...expectedWithoutLink } = expectedWithoutNormalizedLink;

      expect(link).toBe(expectedLink);
      expect(actualWithoutLink).toEqual(expectedWithoutLink);
      expect(languageRow.link).toBe(originalLink);
    },
  );

  it.each([
    ["FR", "fr", "EUR"],
    ["BE_FR", "fr", "EUR"],
    ["BE_DE", "de", "EUR"],
    ["DE", "de", "EUR"],
    ["AT", "de", "EUR"],
    ["LU_DE", "de", "EUR"],
    ["CH_FR", "fr", "CHF"],
    ["CH_DE", "de", "CHF"],
  ] as const)("defines %s with language %s and currency %s", (market, expectedLanguage, expectedCurrency) => {
    expect(META_MARKET_FEEDS[market]).toMatchObject({
      language: expectedLanguage,
      currency: expectedCurrency,
    });
  });

  it("joins the complete schema by exact product id", () => {
    const result = composeMetaMarketRows({
      marketCode: "FR",
      expectedCurrency: "EUR",
      baseRows: [base("variant-1_FR")],
      languageRows: [language("variant-1_FR")],
      countryRows: [country("variant-1_FR")],
    });

    expect(result).toEqual([{
      ...base("variant-1_FR"),
      ...language("variant-1_FR"),
      link: "https://shop.homestorys.com/fr/variant-1_FR",
      ...country("variant-1_FR"),
    }]);
    expect(Object.keys(result[0]!)).toEqual(META_MARKET_FEED_HEADERS);
  });

  it("does not reintroduce ids absent from the market country snapshot", () => {
    const result = composeMetaMarketRows({
      marketCode: "FR",
      expectedCurrency: "EUR",
      baseRows: [base("included_FR"), base("excluded_FR")],
      languageRows: [language("included_FR"), language("excluded_FR")],
      countryRows: [country("included_FR")],
    });

    expect(result.map((row) => row.id)).toEqual(["included_FR"]);
  });

  it.each([
    ["BE_FR", "BE_DE", "EUR"],
    ["BE_DE", "BE_FR", "EUR"],
    ["CH_FR", "CH_DE", "CHF"],
    ["CH_DE", "CH_FR", "CHF"],
  ] as const)(
    "selects only %s rows from a shared bilingual country snapshot",
    (marketCode, otherMarket, currency) => {
      const selectedId = `variant-1_${marketCode}`;
      const otherId = `variant-1_${otherMarket}`;
      const result = composeMetaMarketRows({
        marketCode,
        expectedCurrency: currency,
        baseRows: [base(selectedId), base(otherId)],
        languageRows: [language(selectedId)],
        countryRows: [
          country(selectedId, currency),
          country(otherId, currency),
        ],
      });

      expect(result.map((row) => row.id)).toEqual([selectedId]);
    },
  );

  it("rejects a market row missing its base or language component", () => {
    expect(() => composeMetaMarketRows({
      marketCode: "FR",
      expectedCurrency: "EUR",
      baseRows: [],
      languageRows: [language("variant-1_FR")],
      countryRows: [country("variant-1_FR")],
    })).toThrow("missing BASE");
  });

  it("rejects duplicate ids in any component snapshot", () => {
    expect(() => composeMetaMarketRows({
      marketCode: "FR",
      expectedCurrency: "EUR",
      baseRows: [base("variant-1_FR"), base("variant-1_FR")],
      languageRows: [language("variant-1_FR")],
      countryRows: [country("variant-1_FR")],
    })).toThrow("duplicate id");
  });

  it.each(["CH_FR", "CH_DE"] as const)("rejects non-CHF prices for %s", (marketCode) => {
    expect(() => composeMetaMarketRows({
      marketCode,
      expectedCurrency: "CHF",
      baseRows: [base(`variant-1_${marketCode}`)],
      languageRows: [language(`variant-1_${marketCode}`)],
      countryRows: [country(`variant-1_${marketCode}`, "EUR")],
    })).toThrow("expected CHF");
  });

  it("rejects a sale price that is not lower than price", () => {
    expect(() => composeMetaMarketRows({
      marketCode: "DE",
      expectedCurrency: "EUR",
      baseRows: [base("variant-1_DE")],
      languageRows: [language("variant-1_DE", "Sofa")],
      countryRows: [country("variant-1_DE", "EUR", "100.00", "100.00")],
    })).toThrow("sale_price");
  });
});