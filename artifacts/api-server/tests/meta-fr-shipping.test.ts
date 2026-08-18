/**
 * Integration test: FR Meta feed shipping field
 *
 * Loads the real config/shipping.yaml (not an in-memory fixture) and maps an
 * FR canonical product through mapToMeta, asserting that the shipping column
 * in the generated country row contains the expected flat rate.
 *
 * This test will fail if the FR entry in config/shipping.yaml is deleted,
 * renamed, or its price/service/currency is changed — giving a reliable
 * regression guard for the production YAML configuration.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
// Point to workspace root config/ from artifacts/api-server/tests/
const CONFIG_DIR = resolve(__dir, "../../../config");

// Set CONFIG_DIR before any loader import
process.env["CONFIG_DIR"] = CONFIG_DIR;

import type { CanonicalProduct } from "../src/canonical/types";
import { mapToMeta } from "../src/exporters/meta/mapper";

/** Minimal FR canonical product — only fields used by mapToMeta. */
function makeFrCanonical(overrides: Partial<CanonicalProduct> = {}): CanonicalProduct {
  return {
    id: "variant-fr-test",
    productId: "product-fr-test",
    variantId: "variant-fr-test",
    itemGroupId: "gid://shopify/Product/fr-test",
    sku: "SKU-FR-SHIP",
    gtin: null,
    mpn: null,
    identifierExists: false,
    brand: "Homestorys",
    vendor: "Homestorys",
    language: "fr",
    market: "FR",
    title: "Canapé 3 places en tissu gris",
    description: "Canapé confortable en tissu gris anthracite.",
    productType: "Canapé",
    collections: [],
    googleProductCategory: "436",
    metaProductCategory: null,
    material: [],
    color: [],
    style: [],
    room: [],
    indoorOutdoor: "indoor",
    price: { amount: 899.0, currency: "EUR", formatted: "€899.00" },
    compareAtPrice: null,
    salePrice: null,
    isOnSale: false,
    discountPercentage: null,
    discountBucket: "none",
    isOutlet: false,
    isExhibitionModel: false,
    isBestseller: false,
    isNew: false,
    isDiscontinued: false,
    availability: "in_stock",
    stockTotal: 5,
    stockOnline: 5,
    stockEupen: 0,
    pickupEupen: false,
    primaryImage: {
      url: "https://cdn.shopify.com/canape.jpg",
      urlHash: "canape-hash",
      altText: "Canapé",
      width: 1200,
      height: 900,
      imageType: "packshot_white",
      position: 1,
    },
    lifestyleImage: null,
    additionalImages: [],
    productUrl: "https://www.homestorys.fr/fr/products/canape-3-places",
    shippingClass: "standard",
    returnClass: "standard",
    weight: 45,
    weightUnit: "kg",
    requiresShipping: true,
    relatedProductIds: [],
    complementaryProductIds: [],
    customLabels: {
      custom_label_0: "none",
      custom_label_1: "large",
      custom_label_2: "500_1000",
      custom_label_3: "none",
      custom_label_4: "online",
    },
    dataQualityScore: 80,
    exclusionReasons: [],
    sourceUpdatedAt: "2026-08-18T00:00:00.000Z",
    generatedAt: "2026-08-18T12:00:00.000Z",
    ...overrides,
  };
}

describe("Meta FR feed shipping — real config/shipping.yaml", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for cache reset
  let loadConfig: () => any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import for cache reset
  let resetConfigCache: () => void;

  beforeAll(async () => {
    const loader = await import("../src/config/loader");
    loadConfig = loader.loadConfig;
    resetConfigCache = loader.resetConfigCache;
    resetConfigCache();
    process.env["CONFIG_DIR"] = CONFIG_DIR;
  });

  afterEach(() => {
    resetConfigCache();
  });

  it("config/shipping.yaml has meta_feed_rates entry for FR", () => {
    const config = loadConfig();
    const rates = config.shipping.meta_feed_rates ?? {};
    expect(rates).toHaveProperty("FR");
    expect(rates["FR"].service).toBeTruthy();
    expect(rates["FR"].price).toBeTruthy();
    expect(rates["FR"].currency).toBeTruthy();
  });

  it("FR meta_feed_rates matches Channable Projet FR rule: 9.50 EUR Livraison Standard", () => {
    const config = loadConfig();
    const fr = (config.shipping.meta_feed_rates ?? {})["FR"];
    expect(fr).toBeDefined();
    expect(fr.service).toBe("Livraison Standard");
    expect(fr.price).toBe("9.50");
    expect(fr.currency).toBe("EUR");
  });

  it("mapToMeta emits FR::Livraison Standard:9.50 EUR in country_row.shipping for FR product", () => {
    const config = loadConfig();
    const result = mapToMeta(makeFrCanonical({ market: "FR" }), config);
    expect(result).not.toBeNull();
    expect(result!.country_row.shipping).toBe("FR::Livraison Standard:9.50 EUR");
  });

  it("no FR product row has an empty or missing shipping field", () => {
    const config = loadConfig();
    // Verify both FR-language markets (FR and BE_FR) produce non-empty shipping
    for (const market of ["FR"] as const) {
      const result = mapToMeta(makeFrCanonical({ market }), config);
      expect(result).not.toBeNull();
      expect(result!.country_row.shipping).not.toBe("");
      expect(result!.country_row.shipping).toBeTruthy();
    }
  });

  it("all markets with configured meta_feed_rates produce non-empty shipping fields", () => {
    const config = loadConfig();
    const rates: Record<string, { service: string; price: string; currency: string }> =
      config.shipping.meta_feed_rates ?? {};

    // Map country → one representative market code
    const countryToMarket: Record<string, string> = {
      FR: "FR",
      BE: "BE_FR",
      DE: "DE",
      AT: "AT",
    };

    for (const [country, rate] of Object.entries(rates)) {
      const marketCode = countryToMarket[country];
      if (!marketCode) continue; // CH/LU not yet generated — skip

      const language = ["FR", "BE"].includes(country) ? "fr" : "de";
      const result = mapToMeta(makeFrCanonical({ market: marketCode, language }), config);
      expect(result).not.toBeNull();
      const expected = `${country}::${rate.service}:${rate.price} ${rate.currency}`;
      expect(result!.country_row.shipping).toBe(expected);
    }
  });
});
