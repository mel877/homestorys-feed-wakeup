import { describe, expect, it, vi } from "vitest";
import {
  advancePricingValidationBatch,
  assertShopifyMarketCurrencies,
  selectShopifyMarketPrice,
  syncMarketPricingSlice,
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

describe("advancePricingValidationBatch", () => {
  it("advances many Swiss variant checks in one bounded durable slice", () => {
    const basePrices = Array.from({ length: 3 }, (_, index) => ({
      variantGid: `gid://shopify/ProductVariant/${index + 1}`,
      price: "999.00",
      compareAtPrice: null,
      productHandle: `product-${index + 1}`,
      swissPrice: {
        price: "956.00",
        compareAtPrice: null,
        currency: "CHF",
      },
    }));
    const markets = {
      CH_DE: { country: "CH", currency: "CHF" },
      CH_FR: { country: "CH", currency: "CHF" },
    };

    const first = advancePricingValidationBatch({
      checkpoint: {
        stage: "validate",
        basePrices,
        validateMarketIndex: 0,
        validateBaseIndex: 0,
      },
      markets,
      maxChecks: 4,
    });

    expect(first).toMatchObject({
      stage: "validate",
      validateMarketIndex: 1,
      validateBaseIndex: 1,
    });

    const second = advancePricingValidationBatch({
      checkpoint: first,
      markets,
      maxChecks: 4,
    });

    expect(second).toMatchObject({
      stage: "write",
      baseIndex: 0,
      marketIndex: 0,
    });
  });
});

describe("syncMarketPricingSlice durable writes", () => {
  it("commits market writes and their checkpoint as one fenced unit", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: "variant-1" }]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: upsert,
        }),
      }),
    };
    const commitUnit = vi.fn(async (
      _checkpoint: Record<string, unknown>,
      writer: (transaction: typeof tx) => Promise<void>,
    ) => writer(tx));
    const tracker = { bumpChanged: vi.fn() };

    const result = await syncMarketPricingSlice(
      {} as never,
      tracker as never,
      {
        stage: "write",
        mapping: [],
        priceLists: [],
        baseIndex: 0,
        marketIndex: 0,
        basePrices: [{
          variantGid: "gid://shopify/ProductVariant/1",
          price: "999.00",
          compareAtPrice: null,
          productHandle: "product-1",
          swissPrice: {
            price: "956.00",
            compareAtPrice: null,
            currency: "CHF",
          },
        }],
      },
      async () => true,
      commitUnit as never,
    );

    expect(commitUnit).toHaveBeenCalledOnce();
    expect(commitUnit).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "complete",
        baseIndex: 1,
        marketIndex: 0,
      }),
      expect.any(Function),
    );
    expect(upsert).toHaveBeenCalled();
    expect(result).toMatchObject({
      completed: true,
      checkpoint: {
        stage: "complete",
        baseIndex: 1,
        marketIndex: 0,
      },
    });
  });
});