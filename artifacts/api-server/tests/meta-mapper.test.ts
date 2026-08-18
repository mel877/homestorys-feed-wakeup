/**
 * Tests for src/exporters/meta/mapper.ts
 *
 * Verifies:
 * - Meta product ID format
 * - Availability mapping for all states
 * - Base / language / country layer separation
 * - Null exclusion when no primary image
 * - Language field routing (fr → langFrRows, de → langDeRows)
 * - Country field routing (BE_FR country = "BE", etc.)
 * - Additional image limit (max 20)
 * - Custom labels pass-through in base layer
 */

import { describe, it, expect } from "vitest";
import {
  mapToMeta,
  buildMetaProductId,
  META_BASE_HEADERS,
  META_LANGUAGE_HEADERS,
  META_COUNTRY_HEADERS,
} from "../src/exporters/meta/mapper";
import type { CanonicalProduct } from "../src/canonical/types";
import type { AppConfig } from "../src/config/schemas";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCanonical(overrides: Partial<CanonicalProduct> = {}): CanonicalProduct {
  return {
    id: "variant-uuid-fr",
    productId: "product-uuid-001",
    variantId: "variant-uuid-fr",
    itemGroupId: "gid://shopify/Product/001",
    sku: "SKU-FR-001",
    gtin: "5901234123457",
    mpn: null,
    identifierExists: true,
    brand: "Homestorys",
    vendor: "Homestorys",
    language: "fr",
    market: "FR",
    title: "Table basse en chêne naturel",
    description: "Magnifique table basse en chêne massif.",
    productType: "Table Basse",
    collections: ["Salon"],
    googleProductCategory: "436",
    metaProductCategory: "Furniture > Tables",
    material: ["Chêne"],
    color: ["Naturel"],
    style: [],
    room: ["Salon"],
    indoorOutdoor: "indoor",
    price: { amount: 349.0, currency: "EUR", formatted: "€349.00" },
    compareAtPrice: null,
    salePrice: null,
    isOnSale: false,
    discountPercentage: null,
    discountBucket: "none",
    isOutlet: false,
    isExhibitionModel: false,
    isBestseller: false,
    isNew: true,
    isDiscontinued: false,
    availability: "in_stock",
    stockTotal: 3,
    stockOnline: 3,
    stockEupen: 0,
    pickupEupen: false,
    primaryImage: {
      url: "https://cdn.shopify.com/table.jpg",
      urlHash: "abc",
      altText: "Table",
      width: 1200,
      height: 900,
      imageType: "packshot_white",
      position: 1,
    },
    lifestyleImage: null,
    additionalImages: [],
    productUrl: "https://www.homestorys.fr/fr/products/table-basse?variant=fr-001",
    shippingClass: "standard",
    returnClass: "standard",
    weight: 18.5,
    weightUnit: "kg",
    requiresShipping: true,
    relatedProductIds: [],
    complementaryProductIds: [],
    customLabels: {
      custom_label_0: "new",
      custom_label_1: "medium",
      custom_label_2: "0_500",
      custom_label_3: "none",
      custom_label_4: "online",
    },
    dataQualityScore: 85,
    exclusionReasons: [],
    sourceUpdatedAt: "2024-01-15T10:00:00.000Z",
    generatedAt: "2024-01-16T08:00:00.000Z",
    ...overrides,
  };
}

function makeConfig(): AppConfig {
  return {
    markets: {
      markets: {
        BE_FR: { country: "BE", language: "fr", currency: "EUR" },
        BE_DE: { country: "BE", language: "de", currency: "EUR" },
        FR: { country: "FR", language: "fr", currency: "EUR" },
        DE: { country: "DE", language: "de", currency: "EUR" },
        AT: { country: "AT", language: "de", currency: "EUR" },
      },
      language_masters: {
        fr: { markets: ["BE_FR", "FR"] },
        de: { markets: ["BE_DE", "DE", "AT"] },
      },
    },
    languages: { languages: [] },
    stores: { stores: { eupen: { shopify_location_id: "", google_store_code: "", name: "Eupen", address: { street: "", city: "", postal_code: "", country: "BE" }, pickup_enabled: true } } },
    shipping: { classes: {}, rates: {}, default_class: "standard" },
    returns: { classes: {}, default_class: "standard" },
    categories: { fallback_google_category_id: "436", fallback_google_category_label: "Furniture", fallback_meta_category: "Furniture", mappings: [], collection_mappings: [] },
    labels: { lifecycle_values: [], performance_values: [], price_bands: [], discount_buckets: [], inventory_values: [], new_product_days: 60 },
    feedPolicy: {
      alerts: { item_count_drop_threshold_pct: 5, price_invalid_threshold_pct: 2, meta_feed_stale_hours: 6, stock_stale_hours: 3 },
      snapshot_gate: { max_item_count_drop_pct: 10, require_zero_schema_errors: true },
      dry_run: { google: true, meta: true },
      sync_schedule: { full: "", prices: "", inventory: "", recommendations: "" },
      recommendations: { top_n: 8, price_tolerance_pct: 20, price_tolerance_max_pct: 40 },
      bestseller_scoring: { sales_30d: 0.4, sales_60d: 0.2, revenue_normalized: 0.3, stock_health: 0.1 },
      conditions: { new_product_days: 60 },
      quality_weights: { identity: 0.15, pricing: 0.2, inventory: 0.15, images: 0.2, classification: 0.1, content: 0.1, identifiers: 0.05, shipping: 0.05 },
    },
    complementary: { complementary: {} },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildMetaProductId", () => {
  it("builds ID as {variantId}_{market}", () => {
    const canonical = makeCanonical({ variantId: "uuid-123", market: "FR" });
    expect(buildMetaProductId(canonical)).toBe("uuid-123_FR");
  });

  it("includes market code for BE_FR market", () => {
    const canonical = makeCanonical({ variantId: "uuid-456", market: "BE_FR" });
    expect(buildMetaProductId(canonical)).toBe("uuid-456_BE_FR");
  });
});

describe("mapToMeta", () => {
  it("returns null when primary image is missing", () => {
    const canonical = makeCanonical({ primaryImage: null });
    const result = mapToMeta(canonical, makeConfig());
    expect(result).toBeNull();
  });

  it("returns null for unknown market", () => {
    const canonical = makeCanonical({ market: "UNKNOWN" });
    const result = mapToMeta(canonical, makeConfig());
    expect(result).toBeNull();
  });

  it("returns all three layers: base, language_row, country_row", () => {
    const result = mapToMeta(makeCanonical(), makeConfig());
    expect(result).not.toBeNull();
    expect(result!.base).toBeDefined();
    expect(result!.language_row).toBeDefined();
    expect(result!.country_row).toBeDefined();
  });

  it("sets language from market config", () => {
    const result = mapToMeta(makeCanonical({ market: "DE" }), makeConfig())!;
    expect(result.language).toBe("de");
  });

  it("sets country from market config", () => {
    const result = mapToMeta(makeCanonical({ market: "FR" }), makeConfig())!;
    expect(result.country).toBe("FR");
  });

  it("sets country BE for BE_FR market", () => {
    const result = mapToMeta(makeCanonical({ market: "BE_FR" }), makeConfig())!;
    expect(result.country).toBe("BE");
  });

  it("sets country BE for BE_DE market", () => {
    const result = mapToMeta(makeCanonical({ market: "BE_DE", language: "de" }), makeConfig())!;
    expect(result.country).toBe("BE");
  });

  // ── Base layer ────────────────────────────────────────────────────────────

  it("base.id matches buildMetaProductId", () => {
    const canonical = makeCanonical();
    const result = mapToMeta(canonical, makeConfig())!;
    expect(result.base.id).toBe(buildMetaProductId(canonical));
  });

  it("base.brand is populated", () => {
    const result = mapToMeta(makeCanonical({ brand: "Maison Monde" }), makeConfig())!;
    expect(result.base.brand).toBe("Maison Monde");
  });

  it("base.condition is always 'new'", () => {
    const result = mapToMeta(makeCanonical(), makeConfig())!;
    expect(result.base.condition).toBe("new");
  });

  it("base.image_link is primary image URL", () => {
    const result = mapToMeta(makeCanonical(), makeConfig())!;
    expect(result.base.image_link).toBe("https://cdn.shopify.com/table.jpg");
  });

  it("base has all five custom labels", () => {
    const result = mapToMeta(makeCanonical(), makeConfig())!;
    expect(result.base.custom_label_0).toBe("new");
    expect(result.base.custom_label_1).toBe("medium");
    expect(result.base.custom_label_2).toBe("0_500");
    expect(result.base.custom_label_3).toBe("none");
    expect(result.base.custom_label_4).toBe("online");
  });

  it("base.gtin populated when present", () => {
    const result = mapToMeta(makeCanonical({ gtin: "5901234123457" }), makeConfig())!;
    expect(result.base.gtin).toBe("5901234123457");
  });

  it("base.gtin empty when null", () => {
    const result = mapToMeta(makeCanonical({ gtin: null }), makeConfig())!;
    expect(result.base.gtin).toBe("");
  });

  it("base limits additional images to 20", () => {
    const extras = Array.from({ length: 25 }, (_, i) => ({
      url: `https://cdn.example.com/img-${i}.jpg`,
      urlHash: `h${i}`,
      altText: null,
      width: 800,
      height: 800,
      imageType: "detail" as const,
      position: i + 2,
    }));
    const result = mapToMeta(makeCanonical({ additionalImages: extras }), makeConfig())!;
    const additionalLinks = result.base.additional_image_link.split(",").filter(Boolean);
    expect(additionalLinks.length).toBeLessThanOrEqual(20);
  });

  // ── Language layer ────────────────────────────────────────────────────────

  it("language_row.title matches canonical title", () => {
    const result = mapToMeta(makeCanonical(), makeConfig())!;
    expect(result.language_row.title).toBe("Table basse en chêne naturel");
  });

  it("language_row.link matches productUrl", () => {
    const result = mapToMeta(makeCanonical(), makeConfig())!;
    expect(result.language_row.link).toBe("https://www.homestorys.fr/fr/products/table-basse?variant=fr-001");
  });

  it("language_row.title limited to 500 chars", () => {
    const longTitle = "T".repeat(600);
    const result = mapToMeta(makeCanonical({ title: longTitle }), makeConfig())!;
    expect(result.language_row.title.length).toBe(500);
  });

  it("language_row.description falls back to title when empty", () => {
    const canonical = makeCanonical({ description: "", title: "Fallback Title" });
    const result = mapToMeta(canonical, makeConfig())!;
    expect(result.language_row.description).toBe("Fallback Title");
  });

  // ── Country layer ─────────────────────────────────────────────────────────

  it("country_row.price formatted as '{amount} {currency}'", () => {
    const result = mapToMeta(makeCanonical({ price: { amount: 349, currency: "EUR", formatted: "€349.00" } }), makeConfig())!;
    expect(result.country_row.price).toBe("349.00 EUR");
  });

  it("country_row.sale_price empty when not on sale", () => {
    const result = mapToMeta(makeCanonical({ isOnSale: false, salePrice: null }), makeConfig())!;
    expect(result.country_row.sale_price).toBe("");
  });

  it("country_row.sale_price populated when on sale", () => {
    const canonical = makeCanonical({
      isOnSale: true,
      salePrice: { amount: 249, currency: "EUR", formatted: "€249.00" },
    });
    const result = mapToMeta(canonical, makeConfig())!;
    expect(result.country_row.sale_price).toBe("249.00 EUR");
  });

  it("country_row.availability 'in stock' for in_stock", () => {
    const result = mapToMeta(makeCanonical({ availability: "in_stock" }), makeConfig())!;
    expect(result.country_row.availability).toBe("in stock");
  });

  it("country_row.availability 'available for order' for backorder", () => {
    const result = mapToMeta(makeCanonical({ availability: "backorder" }), makeConfig())!;
    expect(result.country_row.availability).toBe("available for order");
  });

  it("country_row.availability 'out of stock' for out_of_stock", () => {
    const result = mapToMeta(makeCanonical({ availability: "out_of_stock" }), makeConfig())!;
    expect(result.country_row.availability).toBe("out of stock");
  });

  it("country_row.availability 'discontinued' for discontinued", () => {
    const result = mapToMeta(makeCanonical({ availability: "discontinued" }), makeConfig())!;
    expect(result.country_row.availability).toBe("discontinued");
  });

  // ── Header completeness ───────────────────────────────────────────────────

  it("base row has all required headers", () => {
    const result = mapToMeta(makeCanonical(), makeConfig())!;
    for (const h of META_BASE_HEADERS) {
      expect(result.base).toHaveProperty(String(h));
    }
  });

  it("language_row has all required headers", () => {
    const result = mapToMeta(makeCanonical(), makeConfig())!;
    for (const h of META_LANGUAGE_HEADERS) {
      expect(result.language_row).toHaveProperty(String(h));
    }
  });

  it("country_row has all required headers", () => {
    const result = mapToMeta(makeCanonical(), makeConfig())!;
    for (const h of META_COUNTRY_HEADERS) {
      expect(result.country_row).toHaveProperty(String(h));
    }
  });

  // ── Fix 9: shipping field ─────────────────────────────────────────────────

  it("country_row.shipping is empty when meta_feed_rates not configured", () => {
    // Default makeConfig() has no meta_feed_rates — shipping must be "" so
    // Meta falls back to "calculated at checkout" rather than emitting a bad value.
    const result = mapToMeta(makeCanonical({ market: "FR" }), makeConfig())!;
    expect(result.country_row.shipping).toBe("");
  });

  it("country_row.shipping is FR::Livraison Standard:9.50 EUR for FR market", () => {
    const config = makeConfig();
    config.shipping.meta_feed_rates = {
      FR: { service: "Livraison Standard", price: "9.50", currency: "EUR" },
    };
    const result = mapToMeta(makeCanonical({ market: "FR" }), config)!;
    expect(result.country_row.shipping).toBe("FR::Livraison Standard:9.50 EUR");
  });

  it("country_row.shipping is BE::Livraison Standard:9.60 EUR for BE_FR market", () => {
    const config = makeConfig();
    config.shipping.meta_feed_rates = {
      BE: { service: "Livraison Standard", price: "9.60", currency: "EUR" },
    };
    const result = mapToMeta(makeCanonical({ market: "BE_FR" }), config)!;
    expect(result.country_row.shipping).toBe("BE::Livraison Standard:9.60 EUR");
  });

  it("country_row.shipping is DE::Standardlieferung:9.50 EUR for DE market", () => {
    const config = makeConfig();
    config.shipping.meta_feed_rates = {
      DE: { service: "Standardlieferung", price: "9.50", currency: "EUR" },
    };
    const result = mapToMeta(makeCanonical({ market: "DE", language: "de" }), config)!;
    expect(result.country_row.shipping).toBe("DE::Standardlieferung:9.50 EUR");
  });

  it("country_row.shipping is AT::Standardlieferung:19.50 EUR for AT market", () => {
    const config = makeConfig();
    config.shipping.meta_feed_rates = {
      AT: { service: "Standardlieferung", price: "19.50", currency: "EUR" },
    };
    const result = mapToMeta(makeCanonical({ market: "AT", language: "de" }), config)!;
    expect(result.country_row.shipping).toBe("AT::Standardlieferung:19.50 EUR");
  });

  it("country_row.shipping is empty for a market not in meta_feed_rates", () => {
    const config = makeConfig();
    config.shipping.meta_feed_rates = {
      FR: { service: "Livraison Standard", price: "9.50", currency: "EUR" },
    };
    // DE not in rates — should fall back to "" not throw
    const result = mapToMeta(makeCanonical({ market: "DE", language: "de" }), config)!;
    expect(result.country_row.shipping).toBe("");
  });

  it("all configured shipping rates produce non-empty shipping fields", () => {
    const config = makeConfig();
    config.shipping.meta_feed_rates = {
      BE: { service: "Livraison Standard", price: "9.60", currency: "EUR" },
      FR: { service: "Livraison Standard", price: "9.50", currency: "EUR" },
      DE: { service: "Standardlieferung", price: "9.50", currency: "EUR" },
      AT: { service: "Standardlieferung", price: "19.50", currency: "EUR" },
    };
    const cases: Array<{ market: string; language: string; expected: string }> = [
      { market: "FR",    language: "fr", expected: "FR::Livraison Standard:9.50 EUR" },
      { market: "BE_FR", language: "fr", expected: "BE::Livraison Standard:9.60 EUR" },
      { market: "DE",    language: "de", expected: "DE::Standardlieferung:9.50 EUR" },
      { market: "AT",    language: "de", expected: "AT::Standardlieferung:19.50 EUR" },
    ];
    for (const { market, language, expected } of cases) {
      const result = mapToMeta(makeCanonical({ market, language }), config)!;
      expect(result.country_row.shipping).toBe(expected);
    }
  });
});
