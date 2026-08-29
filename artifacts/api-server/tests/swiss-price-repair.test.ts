import { describe, expect, it } from "vitest";
import {
  SwissPriceValidationError,
  assertPairedEurScope,
  buildSwissMarketUpdates,
  chunkVariantIds,
  validateContextualPrices,
} from "../src/shopify/swiss-price-repair";

describe("chunkVariantIds", () => {
  it("never creates a Shopify request containing more than 250 IDs", () => {
    const ids = Array.from(
      { length: 5235 },
      (_, index) => `gid://shopify/ProductVariant/${index + 1}`,
    );

    const batches = chunkVariantIds(ids);

    expect(batches).toHaveLength(21);
    expect(batches.every((batch) => batch.length <= 250)).toBe(true);
    expect(batches.flat()).toEqual(ids);
  });
});

describe("validateContextualPrices", () => {
  const requestedIds = [
    "gid://shopify/ProductVariant/1",
    "gid://shopify/ProductVariant/2",
  ];

  it("accepts only contextual CHF prices and preserves contextual compare-at prices", () => {
    const result = validateContextualPrices(requestedIds, [
      {
        id: requestedIds[0]!,
        contextualPricing: {
          price: { amount: "199.00", currencyCode: "CHF" },
          compareAtPrice: { amount: "249.00", currencyCode: "CHF" },
        },
      },
      {
        id: requestedIds[1]!,
        contextualPricing: {
          price: { amount: "89.50", currencyCode: "CHF" },
          compareAtPrice: null,
        },
      },
    ]);

    expect(result.get(requestedIds[0]!)).toEqual({
      priceAmount: "199.00",
      compareAtPriceAmount: "249.00",
      currency: "CHF",
    });
    expect(result.get(requestedIds[1]!)).toEqual({
      priceAmount: "89.50",
      compareAtPriceAmount: null,
      currency: "CHF",
    });
  });

  it("rejects the whole response set when one contextual price is absent", () => {
    expect(() =>
      validateContextualPrices(requestedIds, [
        {
          id: requestedIds[0]!,
          contextualPricing: {
            price: { amount: "199.00", currencyCode: "CHF" },
            compareAtPrice: null,
          },
        },
        {
          id: requestedIds[1]!,
          contextualPricing: null,
        },
      ]),
    ).toThrow(SwissPriceValidationError);
  });

  it("rejects EUR instead of falling back or converting it", () => {
    try {
      validateContextualPrices([requestedIds[0]!], [
        {
          id: requestedIds[0]!,
          contextualPricing: {
            price: { amount: "199.00", currencyCode: "EUR" },
            compareAtPrice: null,
          },
        },
      ]);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SwissPriceValidationError);
      expect((error as SwissPriceValidationError).issues).toEqual([
        expect.objectContaining({
          variantGid: requestedIds[0],
          code: "NON_CHF_PRICE",
        }),
      ]);
    }
  });

  it("rejects a compare-at price whose currency is not CHF", () => {
    expect(() =>
      validateContextualPrices([requestedIds[0]!], [
        {
          id: requestedIds[0]!,
          contextualPricing: {
            price: { amount: "199.00", currencyCode: "CHF" },
            compareAtPrice: { amount: "249.00", currencyCode: "EUR" },
          },
        },
      ]),
    ).toThrow(SwissPriceValidationError);
  });

  it("reports every invalid or missing response before any write can occur", () => {
    try {
      validateContextualPrices(
        [
          "gid://shopify/ProductVariant/1",
          "gid://shopify/ProductVariant/2",
          "gid://shopify/ProductVariant/3",
        ],
        [
          {
            id: "gid://shopify/ProductVariant/1",
            contextualPricing: null,
          },
          {
            id: "gid://shopify/ProductVariant/2",
            contextualPricing: {
              price: { amount: "0", currencyCode: "CHF" },
              compareAtPrice: null,
            },
          },
        ],
      );
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SwissPriceValidationError);
      expect((error as SwissPriceValidationError).issues).toHaveLength(3);
    }
  });

  it("rejects duplicate Shopify responses for the same variant", () => {
    expect(() =>
      validateContextualPrices([requestedIds[0]!], [
        {
          id: requestedIds[0]!,
          contextualPricing: {
            price: { amount: "199.00", currencyCode: "CHF" },
            compareAtPrice: null,
          },
        },
        {
          id: requestedIds[0]!,
          contextualPricing: {
            price: { amount: "209.00", currencyCode: "CHF" },
            compareAtPrice: null,
          },
        },
      ]),
    ).toThrow(SwissPriceValidationError);
  });

  it("rejects duplicate requested IDs before validating Shopify responses", () => {
    expect(() =>
      validateContextualPrices(
        [requestedIds[0]!, requestedIds[0]!],
        [{
          id: requestedIds[0]!,
          contextualPricing: {
            price: { amount: "199.00", currencyCode: "CHF" },
            compareAtPrice: null,
          },
        }],
      ),
    ).toThrow(SwissPriceValidationError);
  });
});

describe("buildSwissMarketUpdates", () => {
  it("creates identical CH_DE and CH_FR updates from the same Shopify contextual price", () => {
    const updates = buildSwissMarketUpdates(
      new Map([
        [
          "variant-db-id",
          {
            priceAmount: "199.00",
            compareAtPriceAmount: "249.00",
            currency: "CHF" as const,
          },
        ],
      ]),
    );

    expect(updates).toEqual([
      {
        variantId: "variant-db-id",
        marketCode: "CH_DE",
        priceAmount: "199.00",
        compareAtPriceAmount: "249.00",
        priceCurrency: "CHF",
      },
      {
        variantId: "variant-db-id",
        marketCode: "CH_FR",
        priceAmount: "199.00",
        compareAtPriceAmount: "249.00",
        priceCurrency: "CHF",
      },
    ]);
  });
});

describe("assertPairedEurScope", () => {
  it("accepts only variants with both CH_DE and CH_FR rows still in EUR", () => {
    expect(() =>
      assertPairedEurScope(["variant-1"], [
        { variantId: "variant-1", marketCode: "CH_DE", priceCurrency: "EUR" },
        { variantId: "variant-1", marketCode: "CH_FR", priceCurrency: "EUR" },
      ]),
    ).not.toThrow();
  });

  it("rejects a mixed EUR/CHF pair before Shopify is queried", () => {
    expect(() =>
      assertPairedEurScope(["variant-1"], [
        { variantId: "variant-1", marketCode: "CH_DE", priceCurrency: "EUR" },
        { variantId: "variant-1", marketCode: "CH_FR", priceCurrency: "CHF" },
      ]),
    ).toThrow(/paired EUR scope/i);
  });

  it("rejects a missing Swiss market row before Shopify is queried", () => {
    expect(() =>
      assertPairedEurScope(["variant-1"], [
        { variantId: "variant-1", marketCode: "CH_DE", priceCurrency: "EUR" },
      ]),
    ).toThrow(/paired EUR scope/i);
  });
});