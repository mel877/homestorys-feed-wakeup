/**
 * Tests for src/exporters/google/mapper.ts
 *
 * Verifies:
 * - Product ID format
 * - Availability mapping (all states)
 * - Price formatting
 * - TSV serialization (tab escaping, headers)
 * - Null exclusion when no primary image
 * - Custom labels pass-through
 * - Additional images limit (max 10)
 * - mapToGoogleResource returns null for excluded products
 */

import { describe, it, expect } from "vitest";
import {
  mapToGoogleRow,
  mapToGoogleResource,
  buildGoogleProductId,
  buildGoogleRestProductId,
  buildGoogleTsv,
  rowToTsvLine,
  GOOGLE_TSV_HEADERS,
  type GoogleFeedRow,
} from "../src/exporters/google/mapper";
import type { CanonicalProduct } from "../src/canonical/types";
import type { AppConfig } from "../src/config/schemas";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCanonical(overrides: Partial<CanonicalProduct> = {}): CanonicalProduct {
  return {
    id: "variant-uuid-123",
    productId: "product-uuid-456",
    variantId: "variant-uuid-123",
    itemGroupId: "gid://shopify/Product/789",
    sku: "SKU-001",
    gtin: "5901234123457",
    mpn: "MPN-001",
    identifierExists: true,
    brand: "Homestorys",
    vendor: "Homestorys",
    language: "fr",
    market: "BE_FR",
    title: "Canapé 3 places en tissu gris",
    description: "Un magnifique canapé en tissu gris.",
    productType: "Canape",
    collections: ["Salon"],
    googleProductCategory: "436",
    metaProductCategory: "Furniture > Sofas & Couches",
    material: ["Tissu"],
    color: ["Gris"],
    style: ["Contemporain"],
    room: ["Salon"],
    indoorOutdoor: "indoor",
    price: { amount: 599.0, currency: "EUR", formatted: "€599.00" },
    compareAtPrice: { amount: 799.0, currency: "EUR", formatted: "€799.00" },
    salePrice: { amount: 599.0, currency: "EUR", formatted: "€599.00" },
    isOnSale: true,
    discountPercentage: 25,
    discountBucket: "21_30",
    isOutlet: false,
    isExhibitionModel: false,
    isBestseller: false,
    isNew: false,
    isDiscontinued: false,
    availability: "in_stock",
    stockTotal: 5,
    stockOnline: 5,
    stockEupen: 1,
    pickupEupen: true,
    primaryImage: {
      url: "https://cdn.shopify.com/product-image.jpg",
      urlHash: "abc123",
      altText: "Canapé",
      width: 1200,
      height: 900,
      imageType: "packshot_white",
      position: 1,
    },
    lifestyleImage: {
      url: "https://cdn.shopify.com/lifestyle.jpg",
      urlHash: "def456",
      altText: "Style de vie",
      width: 1600,
      height: 900,
      imageType: "lifestyle",
      position: 2,
    },
    additionalImages: [
      {
        url: "https://cdn.shopify.com/detail1.jpg",
        urlHash: "ghi789",
        altText: "Détail 1",
        width: 800,
        height: 800,
        imageType: "detail",
        position: 3,
      },
    ],
    productUrl: "https://www.homestorys.be/fr/products/canape-3-places?variant=123",
    shippingClass: "bulky",
    returnClass: "standard",
    weight: 45.0,
    weightUnit: "kg",
    requiresShipping: true,
    relatedProductIds: [],
    complementaryProductIds: [],
    customLabels: {
      custom_label_0: "sale",
      custom_label_1: "high",
      custom_label_2: "500_1000",
      custom_label_3: "21_30",
      custom_label_4: "online",
    },
    dataQualityScore: 92,
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
    stores: {
      stores: {
        eupen: {
          shopify_location_id: "123",
          google_store_code: "EUPEN",
          name: "Homestorys Eupen",
          address: { street: "Str 1", city: "Eupen", postal_code: "4700", country: "BE" },
          pickup_enabled: true,
        },
      },
    },
    shipping: { classes: {}, rates: {}, default_class: "standard" },
    returns: { classes: {}, default_class: "standard" },
    categories: {
      fallback_google_category_id: "436",
      fallback_google_category_label: "Furniture",
      fallback_meta_category: "Furniture",
      mappings: [],
      collection_mappings: [],
    },
    labels: {
      lifecycle_values: ["outlet", "sale", "new", "evergreen"],
      performance_values: ["bestseller", "high", "medium", "low", "unknown"],
      price_bands: [],
      discount_buckets: [],
      inventory_values: [],
      new_product_days: 60,
    },
    feedPolicy: {
      alerts: {
        item_count_drop_threshold_pct: 5,
        price_invalid_threshold_pct: 2,
        meta_feed_stale_hours: 6,
        stock_stale_hours: 3,
      },
      snapshot_gate: { max_item_count_drop_pct: 10, require_zero_schema_errors: true },
      dry_run: { google: true, meta: true },
      sync_schedule: { full: "0 2 * * *", prices: "0 */4 * * *", inventory: "0 * * * *", recommendations: "0 3 * * 0" },
      recommendations: { top_n: 8, price_tolerance_pct: 20, price_tolerance_max_pct: 40 },
      bestseller_scoring: { sales_30d: 0.4, sales_60d: 0.2, revenue_normalized: 0.3, stock_health: 0.1 },
      conditions: { new_product_days: 60 },
      quality_weights: { identity: 0.15, pricing: 0.2, inventory: 0.15, images: 0.2, classification: 0.1, content: 0.1, identifiers: 0.05, shipping: 0.05 },
    },
    complementary: { complementary: {} },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildGoogleProductId / buildGoogleRestProductId", () => {
  it("builds correct REST product ID format: online:{language}:{country}:{variantId}", () => {
    const canonical = makeCanonical();
    const id = buildGoogleProductId(canonical, "BE");
    expect(id).toBe("online:fr:BE:variant-uuid-123");
  });

  it("buildGoogleRestProductId also builds online:{language}:{country}:{variantId}", () => {
    const canonical = makeCanonical();
    expect(buildGoogleRestProductId(canonical, "BE")).toBe("online:fr:BE:variant-uuid-123");
    // Both functions should be equivalent (buildGoogleProductId is the alias)
    expect(buildGoogleRestProductId(canonical, "BE")).toBe(buildGoogleProductId(canonical, "BE"));
  });

  it("uses market country for DE market", () => {
    const canonical = makeCanonical({ language: "de", market: "DE" });
    const id = buildGoogleProductId(canonical, "DE");
    expect(id).toBe("online:de:DE:variant-uuid-123");
  });
});

describe("Google product API identifier contract", () => {
  it("resource offerId is just the variantId (not the full REST product ID)", () => {
    const canonical = makeCanonical({ variantId: "var-uuid-123" });
    const resource = mapToGoogleResource(canonical, makeConfig())!;

    // offerId must be the raw stable identifier — the API derives the REST ID as
    // channel:contentLanguage:targetCountry:offerId = online:fr:BE:var-uuid-123
    expect(resource.offerId).toBe("var-uuid-123");

    // offerId must NOT contain colons (that would indicate the REST ID form)
    expect(resource.offerId).not.toContain("online:");
  });

  it("offerId does NOT equal the REST product ID built by buildGoogleRestProductId", () => {
    const canonical = makeCanonical({ variantId: "var-uuid-123", language: "fr", market: "BE_FR" });
    const resource = mapToGoogleResource(canonical, makeConfig())!;
    const restId = buildGoogleRestProductId(canonical, "BE");

    expect(resource.offerId).not.toBe(restId);
    expect(resource.offerId).toBe("var-uuid-123");
    expect(restId).toBe("online:fr:BE:var-uuid-123");
  });

  it("TSV row id matches resource offerId (both are the raw variantId)", () => {
    const canonical = makeCanonical({ variantId: "var-uuid-999" });
    const row = mapToGoogleRow(canonical, makeConfig())!;
    const resource = mapToGoogleResource(canonical, makeConfig())!;

    expect(row.id).toBe(resource.offerId);
    expect(row.id).toBe("var-uuid-999");
    expect(row.id).not.toContain("online:");
  });

  it("targetCountry and contentLanguage are set correctly as separate resource fields", () => {
    const canonical = makeCanonical({ language: "de", market: "DE" });
    const resource = mapToGoogleResource(canonical, makeConfig())!;
    expect(resource.targetCountry).toBe("DE");
    expect(resource.contentLanguage).toBe("de");
    expect(resource.channel).toBe("online");
    // REST ID = channel:contentLanguage:targetCountry:offerId = online:de:DE:variant-uuid-123
  });
});

describe("mapToGoogleResource", () => {
  it("returns null when primary image is missing", () => {
    const canonical = makeCanonical({ primaryImage: null });
    const config = makeConfig();
    const result = mapToGoogleResource(canonical, config);
    expect(result).toBeNull();
  });

  it("returns null for unknown market", () => {
    const canonical = makeCanonical({ market: "UNKNOWN" });
    const config = makeConfig();
    const result = mapToGoogleResource(canonical, config);
    expect(result).toBeNull();
  });

  it("maps in_stock to 'in stock'", () => {
    const canonical = makeCanonical({ availability: "in_stock" });
    const result = mapToGoogleResource(canonical, makeConfig())!;
    expect(result.availability).toBe("in stock");
  });

  it("maps low_stock to 'in stock'", () => {
    const canonical = makeCanonical({ availability: "low_stock" });
    const result = mapToGoogleResource(canonical, makeConfig())!;
    expect(result.availability).toBe("in stock");
  });

  it("maps backorder to 'backorder'", () => {
    const canonical = makeCanonical({ availability: "backorder" });
    const result = mapToGoogleResource(canonical, makeConfig())!;
    expect(result.availability).toBe("backorder");
  });

  it("maps out_of_stock to 'out of stock'", () => {
    const canonical = makeCanonical({ availability: "out_of_stock" });
    const result = mapToGoogleResource(canonical, makeConfig())!;
    expect(result.availability).toBe("out of stock");
  });

  it("maps discontinued to 'out of stock'", () => {
    const canonical = makeCanonical({ availability: "discontinued" });
    const result = mapToGoogleResource(canonical, makeConfig())!;
    expect(result.availability).toBe("out of stock");
  });

  it("formats price as value + currency object", () => {
    const result = mapToGoogleResource(makeCanonical(), makeConfig())!;
    expect(result.price).toEqual({ value: "599.00", currency: "EUR" });
  });

  it("includes salePrice when product is on sale", () => {
    const result = mapToGoogleResource(makeCanonical(), makeConfig())!;
    expect(result.salePrice).toEqual({ value: "599.00", currency: "EUR" });
  });

  it("omits salePrice when not on sale", () => {
    const canonical = makeCanonical({ isOnSale: false, salePrice: null });
    const result = mapToGoogleResource(canonical, makeConfig())!;
    expect(result.salePrice).toBeUndefined();
  });

  it("sets condition to 'new'", () => {
    const result = mapToGoogleResource(makeCanonical(), makeConfig())!;
    expect(result.condition).toBe("new");
  });

  it("sets channel to 'online'", () => {
    const result = mapToGoogleResource(makeCanonical(), makeConfig())!;
    expect(result.channel).toBe("online");
  });

  it("sets targetCountry from market.country", () => {
    const result = mapToGoogleResource(makeCanonical({ market: "BE_FR" }), makeConfig())!;
    expect(result.targetCountry).toBe("BE");
  });

  it("sets contentLanguage from market.language", () => {
    const result = mapToGoogleResource(makeCanonical({ market: "DE" }), makeConfig())!;
    expect(result.contentLanguage).toBe("de");
  });

  it("includes gtin when present", () => {
    const result = mapToGoogleResource(makeCanonical({ gtin: "5901234123457" }), makeConfig())!;
    expect(result.gtin).toBe("5901234123457");
  });

  it("omits gtin when null", () => {
    const result = mapToGoogleResource(makeCanonical({ gtin: null }), makeConfig())!;
    expect(result.gtin).toBeUndefined();
  });

  it("passes all five custom labels", () => {
    const result = mapToGoogleResource(makeCanonical(), makeConfig())!;
    expect(result.customLabel0).toBe("sale");
    expect(result.customLabel1).toBe("high");
    expect(result.customLabel2).toBe("500_1000");
    expect(result.customLabel3).toBe("21_30");
    expect(result.customLabel4).toBe("online");
  });

  it("limits title to 150 chars", () => {
    const longTitle = "A".repeat(200);
    const result = mapToGoogleResource(makeCanonical({ title: longTitle }), makeConfig())!;
    expect(result.title.length).toBe(150);
  });

  it("limits description to 5000 chars", () => {
    const longDesc = "B".repeat(6000);
    const result = mapToGoogleResource(makeCanonical({ description: longDesc }), makeConfig())!;
    expect(result.description.length).toBe(5000);
  });

  it("falls back to title as base when description is empty", () => {
    const canonical = makeCanonical({ description: "" });
    const result = mapToGoogleResource(canonical, makeConfig())!;
    // When description is empty the mapper uses the title as the raw content base;
    // the brand suffix may be appended to short content so we verify the title is
    // still the lead text, not that it is the entire description.
    expect(result.description.startsWith(canonical.title)).toBe(true);
  });

  it("includes lifestyle image in lifestyleImageLinks", () => {
    const result = mapToGoogleResource(makeCanonical(), makeConfig())!;
    expect(result.lifestyleImageLinks).toContain("https://cdn.shopify.com/lifestyle.jpg");
  });

  it("sets shippingWeight when weight is present", () => {
    const result = mapToGoogleResource(makeCanonical({ weight: 45, weightUnit: "kg" }), makeConfig())!;
    expect(result.shippingWeight).toEqual({ value: 45, unit: "kg" });
  });

  it("omits shippingWeight when weight is null", () => {
    const result = mapToGoogleResource(makeCanonical({ weight: null }), makeConfig())!;
    expect(result.shippingWeight).toBeUndefined();
  });

  it("limits additional image links to 10", () => {
    const extraImages = Array.from({ length: 15 }, (_, i) => ({
      url: `https://cdn.example.com/img-${i}.jpg`,
      urlHash: `hash-${i}`,
      altText: null,
      width: 800,
      height: 800,
      imageType: "detail" as const,
      position: i + 3,
    }));
    const canonical = makeCanonical({ additionalImages: extraImages });
    const result = mapToGoogleResource(canonical, makeConfig())!;
    expect(result.additionalImageLinks.length).toBeLessThanOrEqual(10);
  });
});

describe("mapToGoogleRow", () => {
  it("returns a flat row with all required headers", () => {
    const row = mapToGoogleRow(makeCanonical(), makeConfig());
    expect(row).not.toBeNull();
    for (const h of GOOGLE_TSV_HEADERS) {
      expect(row).toHaveProperty(h);
    }
  });

  it("formats price as '{amount} {currency}'", () => {
    const row = mapToGoogleRow(makeCanonical(), makeConfig())!;
    expect(row.price).toBe("599.00 EUR");
  });

  it("formats sale_price when on sale", () => {
    const row = mapToGoogleRow(makeCanonical(), makeConfig())!;
    expect(row.sale_price).toBe("599.00 EUR");
  });

  it("leaves sale_price empty when not on sale", () => {
    const canonical = makeCanonical({ isOnSale: false, salePrice: null });
    const row = mapToGoogleRow(canonical, makeConfig())!;
    expect(row.sale_price).toBe("");
  });

  it("sets identifier_exists to 'yes' when gtin present", () => {
    const row = mapToGoogleRow(makeCanonical({ gtin: "5901234123457", identifierExists: true }), makeConfig())!;
    expect(row.identifier_exists).toBe("yes");
  });

  it("sets identifier_exists to 'no' when no identifiers", () => {
    const row = mapToGoogleRow(makeCanonical({ gtin: null, mpn: null, identifierExists: false }), makeConfig())!;
    expect(row.identifier_exists).toBe("no");
  });

  it("formats shipping_weight as '{value} {unit}'", () => {
    const row = mapToGoogleRow(makeCanonical({ weight: 45, weightUnit: "kg" }), makeConfig())!;
    expect(row.shipping_weight).toBe("45 kg");
  });

  it("returns null when primary image is null", () => {
    const result = mapToGoogleRow(makeCanonical({ primaryImage: null }), makeConfig());
    expect(result).toBeNull();
  });
});

describe("TSV serialization", () => {
  it("rowToTsvLine escapes embedded tabs", () => {
    const row: GoogleFeedRow = {
      id: "x",
      title: "Canapé\twith tab",
      description: "",
      link: "https://example.com",
      image_link: "https://example.com/img.jpg",
      additional_image_link: "",
      lifestyle_image_link: "",
      availability: "in stock",
      availability_date: "",
      price: "100.00 EUR",
      sale_price: "",
      sale_price_effective_date: "",
      brand: "Brand",
      gtin: "",
      mpn: "",
      identifier_exists: "no",
      condition: "new",
      google_product_category: "436",
      product_type: "",
      item_group_id: "grp1",
      color: "",
      material: "",
      size: "",
      shipping_weight: "",
      custom_label_0: "evergreen",
      custom_label_1: "unknown",
      custom_label_2: "0_500",
      custom_label_3: "none",
      custom_label_4: "online",
      product_detail: "",
      product_highlight: "",
    };
    const line = rowToTsvLine(row);
    // The embedded tab in title should be escaped to literal \t
    expect(line).toContain("\\t");
    // The title field itself should not contain a real tab character
    const fields = line.split("\t");
    const titleField = fields[1]; // title is second column
    expect(titleField).not.toContain("\t");
    expect(titleField).toBe("Canapé\\twith tab");
  });

  it("buildGoogleTsv starts with correct header line", () => {
    const tsv = buildGoogleTsv([]);
    const firstLine = tsv.split("\n")[0]!;
    expect(firstLine.split("\t")[0]).toBe("id");
    expect(firstLine.split("\t").length).toBe(GOOGLE_TSV_HEADERS.length);
  });

  it("buildGoogleTsv includes one data row per product", () => {
    const row = mapToGoogleRow(makeCanonical(), makeConfig())!;
    const tsv = buildGoogleTsv([row]);
    const lines = tsv.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(2); // header + 1 data row
  });
});
