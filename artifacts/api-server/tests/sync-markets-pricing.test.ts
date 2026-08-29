import { describe, expect, it } from "vitest";
import {
  assertShopifyMarketCurrencies,
  selectShopifyMarketPrice,
} from "../src/shopify/sync-markets";

describe("assertShopifyMarketCurrencies", () => {
  it("rejects a Swiss market configured with a non-CHF currency", () => {
    expect(() =>
      assertShopifyMarketCurrencies({
        CH_DE: {
          country: "CH",
          language: "de",
          currency: "EUR",
        },
      }),
    ).toThrow("CH_DE");
  });
});

describe("selectShopifyMarketPrice", () => {
  const base = {
    price: "999.00",
    compareAtPrice: null,
    productHandle: "fermob-sonnenliege-alize",
    swissPrice: {
      price: "956.0",
      compareAtPrice: null,
      currency: "CHF",
    },
  };

  it("uses Shopify contextual CHF pricing for Swiss markets", () => {
    expect(selectShopifyMarketPrice({
      marketCode: "CH_DE",
      country: "CH",
      configuredCurrency: "CHF",
      base,
      override: {
        variantGid: "gid://shopify/ProductVariant/1",
        price: "999.00",
        compareAtPrice: null,
        currency: "EUR",
      },
    })).toEqual({
      price: "956.0",
      compareAtPrice: null,
      currency: "CHF",
    });
  });

  it("rejects a Swiss row when Shopify contextual pricing is not CHF", () => {
    expect(() => selectShopifyMarketPrice({
      marketCode: "CH_DE",
      country: "CH",
      configuredCurrency: "CHF",
      base: {
        ...base,
        swissPrice: {
          price: "999.00",
          compareAtPrice: null,
          currency: "EUR",
        },
      },
      override: undefined,
    })).toThrow("CH_DE");
  });

  it("keeps using price-list overrides for non-Swiss markets", () => {
    expect(selectShopifyMarketPrice({
      marketCode: "DE",
      country: "DE",
      configuredCurrency: "EUR",
      base,
      override: {
        variantGid: "gid://shopify/ProductVariant/1",
        price: "899.00",
        compareAtPrice: "999.00",
        currency: "EUR",
      },
    })).toEqual({
      price: "899.00",
      compareAtPrice: "999.00",
      currency: "EUR",
    });
  });

  it("rejects an override whose currency differs from the configured market", () => {
    expect(() => selectShopifyMarketPrice({
      marketCode: "DE",
      country: "DE",
      configuredCurrency: "EUR",
      base,
      override: {
        variantGid: "gid://shopify/ProductVariant/1",
        price: "899.00",
        compareAtPrice: null,
        currency: "USD",
      },
    })).toThrow("DE");
  });
});