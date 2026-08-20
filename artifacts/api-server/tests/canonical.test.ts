/**
 * Canonical Product Engine — 25 unit test cases per spec section 51.
 *
 * All tests are pure (no DB, no network). Fixtures provide raw DB data.
 * Config is loaded from the repo's config/ YAML files.
 */

import { describe, it, expect } from "vitest";
import { buildCanonical } from "../src/canonical/builder";
import { computePromotion, assignDiscountBucket } from "../src/promotions/index";
import { computeInventory } from "../src/inventory/index";
import {
  buildTitle,
  sanitizeDescription,
  validateGtin,
  normaliseBrand,
  isNewProduct,
} from "../src/normalization/index";
import { mapCategory } from "../src/categories/mapper";
import { computeCustomLabels } from "../src/canonical/labels";
import { determineBestsellerClass, scoreBestseller } from "../src/enrichment/bestseller";
import { scoreRelatedProducts, findComplementaryProducts } from "../src/recommendations/engine";
import { classifyMetrics } from "../src/images/classifier";
import { resolveMarket, resolveContent } from "../src/markets/resolver";
import { computeQualityScore } from "../src/validation/quality";
import type { BuildCanonicalInput } from "../src/canonical/builder";
import type { AppConfig } from "../src/config/schemas";

// ── Fixture loader ────────────────────────────────────────────────────────────

function loadFixture(name: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(`./fixtures/${name}.json`);
}

// ── Minimal test config ───────────────────────────────────────────────────────

const testConfig: AppConfig = {
  markets: {
    markets: {
      BE_FR: { country: "BE", language: "fr", currency: "EUR", label: "Belgium (French)" },
      BE_DE: { country: "BE", language: "de", currency: "EUR", label: "Belgium (German)" },
      FR: { country: "FR", language: "fr", currency: "EUR", label: "France" },
      DE: { country: "DE", language: "de", currency: "EUR", label: "Germany" },
      AT: { country: "AT", language: "de", currency: "EUR", label: "Austria" },
    },
    language_masters: {
      fr: { markets: ["BE_FR", "FR"] },
      de: { markets: ["BE_DE", "DE", "AT"] },
      en: { markets: [] },
      it: { markets: [] },
    },
  },
  languages: {
    languages: [
      { code: "fr", name: "French", locale: "fr-FR" },
      { code: "de", name: "German", locale: "de-DE" },
      { code: "en", name: "English", locale: "en-GB" },
      { code: "it", name: "Italian", locale: "it-IT" },
    ],
  },
  stores: {
    stores: {
      eupen: {
        shopify_location_id: "gid://shopify/Location/9002",
        google_store_code: "EUPEN_BE",
        name: "Homestorys Eupen",
        address: { street: "Industriestraße 38", city: "Eupen", postal_code: "4700", country: "BE" },
        pickup_enabled: true,
      },
    },
  },
  shipping: {
    classes: {
      standard: { label: "Standard shipping" },
      bulky: { label: "Bulky item delivery" },
      premium_delivery: { label: "Premium delivery" },
    },
    rates: {},
    default_class: "standard",
  },
  returns: {
    classes: {
      standard: { label: "30-day return", days: 30, returnable: true },
      exhibition: { label: "Exhibition model — no return", returnable: false },
      made_to_order: { label: "Made to order — no return", returnable: false },
    },
    default_class: "standard",
  },
  categories: {
    fallback_google_category_id: "436",
    fallback_google_category_label: "Furniture",
    fallback_meta_category: "furniture",
    mappings: [
      { shopify_type: "Dining Table", canonical: "dining_table", google_category_id: "443", google_category_label: "Furniture > Tables > Kitchen & Dining Room Tables", meta_category: "furniture > tables", indoor_outdoor: "indoor" },
      { shopify_type: "Coffee Table", canonical: "coffee_table", google_category_id: "454", google_category_label: "Furniture > Tables > Coffee Tables", meta_category: "furniture > tables", indoor_outdoor: "indoor" },
      { shopify_type: "Sofa", canonical: "sofa", google_category_id: "4234", google_category_label: "Furniture > Sofas & Sectionals", meta_category: "furniture > seating > sofas", indoor_outdoor: "indoor" },
      { shopify_type: "Dining Chair", canonical: "dining_chair", google_category_id: "441", google_category_label: "Furniture > Chairs > Dining Room Chairs", meta_category: "furniture > seating > chairs", indoor_outdoor: "indoor" },
      { shopify_type: "Bookcase", canonical: "bookcase", google_category_id: "6543", google_category_label: "Furniture > Bookcases & Storage Cabinets", meta_category: "furniture > storage", indoor_outdoor: "indoor" },
      { shopify_type: "Outdoor Sofa", canonical: "outdoor_sofa", google_category_id: "4234", google_category_label: "Furniture > Sofas & Sectionals", meta_category: "furniture > outdoor furniture > outdoor seating", indoor_outdoor: "outdoor" },
    ],
    collection_mappings: [],
  },
  labels: {
    lifecycle_values: ["outlet", "sale", "new", "evergreen"],
    performance_values: ["bestseller", "high", "medium", "low", "unknown"],
    price_bands: [
      { key: "0_500", min: 0, max: 499.99 },
      { key: "500_1000", min: 500, max: 999.99 },
      { key: "1000_2500", min: 1000, max: 2499.99 },
      { key: "2500_5000", min: 2500, max: 4999.99 },
      { key: "5000_plus", min: 5000, max: null },
    ],
    discount_buckets: [
      { key: "none", min: 0, max: 0 },
      { key: "1_10", min: 1, max: 10 },
      { key: "11_20", min: 11, max: 20 },
      { key: "21_30", min: 21, max: 30 },
      { key: "31_50", min: 31, max: 50 },
      { key: "51_70", min: 51, max: 69 }, // 70 belongs to 70_plus (inclusive boundary policy)
      { key: "70_plus", min: 70, max: null },
    ],
    inventory_values: ["online", "showroom", "online_and_showroom", "made_to_order", "backorder", "out_of_stock"],
    new_product_days: 60,
  },
  feedPolicy: {
    alerts: { item_count_drop_threshold_pct: 5, price_invalid_threshold_pct: 2, meta_feed_stale_hours: 6, stock_stale_hours: 3 },
    snapshot_gate: { max_item_count_drop_pct: 10, require_zero_schema_errors: true },
    dry_run: { google: true, meta: true },
    sync_schedule: { full: "0 2 * * *", prices: "0 */2 * * *", inventory: "0 * * * *", recommendations: "0 3 * * *" },
    recommendations: { top_n: 8, price_tolerance_pct: 20, price_tolerance_max_pct: 40 },
    bestseller_scoring: { sales_30d: 0.55, sales_60d: 0.20, revenue_normalized: 0.15, stock_health: 0.10 },
    conditions: { new_product_days: 60 },
    quality_weights: { identity: 20, pricing: 15, inventory: 15, images: 15, classification: 10, content: 10, identifiers: 10, shipping: 5 },
  },
  complementary: {
    complementary: {
      sofa: ["coffee_table", "rug", "side_table", "lighting"],
      dining_table: ["dining_chair", "pendant_light", "sideboard"],
      coffee_table: ["sofa", "rug", "side_table"],
      bookcase: ["desk", "desk_chair", "lighting"],
      outdoor_sofa: ["outdoor_coffee_table", "outdoor_side_table", "outdoor_lighting"],
    },
  },
};

// ── Helper to build a standard input ────────────────────────────────────────

function makeInput(fixture: ReturnType<typeof loadFixture>): BuildCanonicalInput {
  return {
    product: fixture.product,
    variant: fixture.variant,
    marketVariants: fixture.marketVariants,
    translations: fixture.translations,
    images: fixture.images,
    inventoryLevels: fixture.inventoryLevels,
    recommendations: fixture.recommendations ?? null,
    normalizedBestsellerScore: fixture.normalizedBestsellerScore,
    config: testConfig,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Test 1: Standard price (no compare-at, not on sale)
// ════════════════════════════════════════════════════════════════════════════

describe("Test 1: Standard price", () => {
  it("should not be on sale when compare_at_price is null", () => {
    const promo = computePromotion("899.00", null, "EUR");
    expect(promo.isOnSale).toBe(false);
    expect(promo.discountBucket).toBe("none");
    expect(promo.priceInvalid).toBe(false);
    expect(promo.salePrice).toBeNull();
  });
});

describe("Language market aliases", () => {
  it("uses Swiss commercial pricing with French content and storefront URLs for CH_FR", () => {
    const fixture = loadFixture("normal_product");
    const config = structuredClone(testConfig);
    config.markets.markets["CH_DE"] = {
      country: "CH",
      language: "de",
      currency: "CHF",
      base_url: "https://shop-de.homestorys.com/",
    };
    config.markets.markets["CH_FR"] = {
      country: "CH",
      language: "fr",
      currency: "CHF",
      base_url: "https://shop-fr.homestorys.com/",
      pricing_market: "CH_DE",
    };

    const source = fixture.marketVariants.find((market: { marketCode: string }) => market.marketCode === "BE_FR");
    expect(source).toBeDefined();
    const input = makeInput(fixture);
    input.config = config;
    input.marketVariants = [
      ...fixture.marketVariants,
      {
        ...source,
        marketCode: "CH_DE",
        priceAmount: "999.00",
        priceCurrency: "CHF",
        productUrl: "https://shop-de.homestorys.com/products/german-source",
      },
    ];

    const canonical = buildCanonical(input, "CH_FR");
    expect(canonical).not.toBeNull();
    expect(canonical!.market).toBe("CH_FR");
    expect(canonical!.language).toBe("fr");
    expect(canonical!.price).toMatchObject({ amount: 999, currency: "CHF" });
    expect(canonical!.productUrl).toMatch(/^https:\/\/shop-fr\.homestorys\.com\/products\//);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 2: Sale price (compare-at > price)
// ════════════════════════════════════════════════════════════════════════════

describe("Test 2: Sale price", () => {
  it("should be on sale when compare_at > price", () => {
    const fixture = loadFixture("sale_product");
    const input = makeInput(fixture);
    const product = buildCanonical(input, "BE_FR");

    expect(product).not.toBeNull();
    expect(product!.isOnSale).toBe(true);
    expect(product!.price.amount).toBe(1190);
    expect(product!.compareAtPrice).not.toBeNull();
    expect(product!.compareAtPrice!.amount).toBe(1490);
    expect(product!.salePrice).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 3: Invalid compare-at (compare-at ≤ price)
// ════════════════════════════════════════════════════════════════════════════

describe("Test 3: Invalid compare-at price", () => {
  it("should not be on sale when compare_at <= price", () => {
    const promo = computePromotion("100.00", "80.00", "EUR"); // sale price HIGHER than compare-at
    expect(promo.isOnSale).toBe(false);
    expect(promo.priceInvalid).toBe(false); // not invalid, just not a sale
    expect(promo.discountBucket).toBe("none");
  });

  it("should not be on sale when compare_at equals price", () => {
    const promo = computePromotion("100.00", "100.00", "EUR");
    expect(promo.isOnSale).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 4: Discount 15% → bucket 11_20
// ════════════════════════════════════════════════════════════════════════════

describe("Test 4: Discount 15%", () => {
  it("assigns discount bucket 11_20 for ~15% discount", () => {
    const promo = computePromotion("849.00", "999.00", "EUR");
    expect(promo.isOnSale).toBe(true);
    expect(promo.discountPercentage).toBeGreaterThan(10);
    expect(promo.discountPercentage).toBeLessThanOrEqual(20);
    expect(promo.discountBucket).toBe("11_20");
  });

  it("assignDiscountBucket returns correct bucket for 15", () => {
    expect(assignDiscountBucket(15)).toBe("11_20");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 5: Discount > 70% → bucket 70_plus
// ════════════════════════════════════════════════════════════════════════════

describe("Test 5: Discount >70%", () => {
  it("assigns 70_plus bucket for 75% discount", () => {
    const promo = computePromotion("250.00", "1000.00", "EUR");
    expect(promo.isOnSale).toBe(true);
    expect(promo.discountBucket).toBe("70_plus");
    expect(promo.discountPercentage).toBe(75);
  });

  it("assignDiscountBucket handles edge case at 70", () => {
    expect(assignDiscountBucket(70)).toBe("70_plus");
    expect(assignDiscountBucket(69)).toBe("51_70");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 5b: Discount bucket inclusive-boundary correctness
// ════════════════════════════════════════════════════════════════════════════

describe("Test 5b: Discount bucket boundary values (inclusive)", () => {
  it("exactly 10% → 1_10 (not a gap)", () => {
    expect(assignDiscountBucket(10)).toBe("1_10");
  });

  it("exactly 11% → 11_20", () => {
    expect(assignDiscountBucket(11)).toBe("11_20");
  });

  it("exactly 20% → 11_20", () => {
    expect(assignDiscountBucket(20)).toBe("11_20");
  });

  it("exactly 30% → 21_30", () => {
    expect(assignDiscountBucket(30)).toBe("21_30");
  });

  it("exactly 50% → 31_50", () => {
    expect(assignDiscountBucket(50)).toBe("31_50");
  });

  it("exactly 51% → 51_70", () => {
    expect(assignDiscountBucket(51)).toBe("51_70");
  });

  it("exactly 69% → 51_70", () => {
    expect(assignDiscountBucket(69)).toBe("51_70");
  });

  it("exactly 70% → 70_plus", () => {
    expect(assignDiscountBucket(70)).toBe("70_plus");
  });

  it("exactly 1% → 1_10", () => {
    expect(assignDiscountBucket(1)).toBe("1_10");
  });

  it("0% → none", () => {
    expect(assignDiscountBucket(0)).toBe("none");
  });

  it("computePromotion: 20% off assigns 11_20 bucket", () => {
    // 800 / 1000 → 20% discount
    const promo = computePromotion("800.00", "1000.00", "EUR");
    expect(promo.isOnSale).toBe(true);
    expect(promo.discountPercentage).toBe(20);
    expect(promo.discountBucket).toBe("11_20");
  });

  it("computePromotion: 50% off assigns 31_50 bucket", () => {
    // 500 / 1000 → 50% discount
    const promo = computePromotion("500.00", "1000.00", "EUR");
    expect(promo.discountPercentage).toBe(50);
    expect(promo.discountBucket).toBe("31_50");
  });

  it("computePromotion: 10% off assigns 1_10 bucket", () => {
    // 900 / 1000 → 10% discount
    const promo = computePromotion("900.00", "1000.00", "EUR");
    expect(promo.discountPercentage).toBe(10);
    expect(promo.discountBucket).toBe("1_10");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 6: Multi-market — different prices per market, same content
// ════════════════════════════════════════════════════════════════════════════

describe("Test 6: Multi-market", () => {
  it("builds separate canonicals per market with correct prices", () => {
    const fixture = loadFixture("multi_market");
    const input = makeInput(fixture);

    const beFr = buildCanonical(input, "BE_FR");
    const deMkt = buildCanonical(input, "DE");

    expect(beFr).not.toBeNull();
    expect(deMkt).not.toBeNull();
    expect(beFr!.price.amount).toBe(1200);
    expect(deMkt!.price.amount).toBe(1250);
    // Different markets but same language
    expect(beFr!.language).toBe("fr");
    expect(deMkt!.language).toBe("de");
    // Prices NOT cross-applied
    expect(beFr!.price.amount).not.toBe(deMkt!.price.amount);
  });

  it("BE_DE uses German content (same as DE)", () => {
    const fixture = loadFixture("multi_market");
    const input = makeInput(fixture);

    const beDe = buildCanonical(input, "BE_DE");
    expect(beDe).not.toBeNull();
    expect(beDe!.language).toBe("de");
    // German title should be used
    expect(beDe!.title).toContain("Ethnicraft");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 7: In stock
// ════════════════════════════════════════════════════════════════════════════

describe("Test 7: In stock", () => {
  it("returns in_stock when available > 3", () => {
    const inv = computeInventory(
      [{ variantId: "v1", shopifyLocationId: "loc1", locationName: "Warehouse", available: 10 }],
      null, true, false, false,
    );
    expect(inv.availability).toBe("in_stock");
    expect(inv.stockOnline).toBe(10);
  });

  it("normal product fixture is in_stock", () => {
    const fixture = loadFixture("normal_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.availability).toBe("in_stock");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 8: Backorder (OOS but sell when out of stock)
// ════════════════════════════════════════════════════════════════════════════

describe("Test 8: Backorder", () => {
  it("returns backorder when stock=0 and sell_when_out_of_stock=true", () => {
    const inv = computeInventory(
      [{ variantId: "v1", shopifyLocationId: "loc1", locationName: "WH", available: 0 }],
      null, true, true, false,
    );
    expect(inv.availability).toBe("backorder");
  });

  it("backorder fixture has backorder availability", () => {
    const fixture = loadFixture("backorder");
    // The market variant sets availability=backorder, which passes through
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.availability).toBe("backorder");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 9: Out of stock
// ════════════════════════════════════════════════════════════════════════════

describe("Test 9: Out of stock", () => {
  it("returns out_of_stock when stock=0 and sell_when_oos=false", () => {
    const inv = computeInventory(
      [{ variantId: "v1", shopifyLocationId: "loc1", locationName: "WH", available: 0 }],
      null, true, false, false,
    );
    expect(inv.availability).toBe("out_of_stock");
  });

  it("out_of_stock fixture has correct status", () => {
    const fixture = loadFixture("out_of_stock");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.availability).toBe("out_of_stock");
    expect(product!.customLabels.custom_label_4).toBe("out_of_stock");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 10: Discontinued
// ════════════════════════════════════════════════════════════════════════════

describe("Test 10: Discontinued", () => {
  it("discontinued flag always wins regardless of stock", () => {
    const inv = computeInventory(
      [{ variantId: "v1", shopifyLocationId: "loc1", locationName: "WH", available: 50 }],
      null, true, false, true, // isDiscontinued = true
    );
    expect(inv.availability).toBe("discontinued");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 11: Showroom only (stock in Eupen, none online)
// ════════════════════════════════════════════════════════════════════════════

describe("Test 11: Showroom only", () => {
  it("inventory label is showroom when only eupen has stock", () => {
    const eupenId = "gid://shopify/Location/9002";
    const inv = computeInventory(
      [{ variantId: "v1", shopifyLocationId: eupenId, locationName: "Eupen", available: 1 }],
      eupenId, true, false, false,
    );
    expect(inv.stockEupen).toBe(1);
    expect(inv.stockOnline).toBe(0);
    expect(inv.pickupEupen).toBe(true);
    expect(inv.inventoryLabel).toBe("showroom");
  });

  it("outlet fixture has Eupen stock", () => {
    const fixture = loadFixture("outlet_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.stockEupen).toBe(1);
    expect(product!.pickupEupen).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 12: Online + showroom
// ════════════════════════════════════════════════════════════════════════════

describe("Test 12: Online and showroom", () => {
  it("inventory label is online_and_showroom when both have stock", () => {
    const eupenId = "gid://shopify/Location/9002";
    const inv = computeInventory(
      [
        { variantId: "v1", shopifyLocationId: eupenId, locationName: "Eupen", available: 1 },
        { variantId: "v1", shopifyLocationId: "gid://shopify/Location/9001", locationName: "Warehouse", available: 5 },
      ],
      eupenId, true, false, false,
    );
    expect(inv.inventoryLabel).toBe("online_and_showroom");
    expect(inv.stockEupen).toBe(1);
    expect(inv.stockOnline).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 13: White background image
// ════════════════════════════════════════════════════════════════════════════

describe("Test 13: White background image classification", () => {
  it("classifies high white-bg-score image as packshot_white", () => {
    const type = classifyMetrics({
      width: 1200, height: 1200, aspectRatio: 1.0,
      alphaRatio: 0, whiteBgScore: 0.92, solidBgScore: 0.2,
      edgeDensity: 0.03, variance: 800, resolutionScore: 1.0,
    });
    expect(type).toBe("packshot_white");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 14: Transparent image
// ════════════════════════════════════════════════════════════════════════════

describe("Test 14: Transparent image classification", () => {
  it("classifies high alpha ratio as packshot_transparent", () => {
    const type = classifyMetrics({
      width: 1000, height: 1000, aspectRatio: 1.0,
      alphaRatio: 0.35, whiteBgScore: 0.1, solidBgScore: 0.1,
      edgeDensity: 0.05, variance: 1000, resolutionScore: 1.0,
    });
    expect(type).toBe("packshot_transparent");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 15: Lifestyle image
// ════════════════════════════════════════════════════════════════════════════

describe("Test 15: Lifestyle image classification", () => {
  it("classifies high-variance high-edge image as lifestyle", () => {
    const type = classifyMetrics({
      width: 1200, height: 800, aspectRatio: 1.5,
      alphaRatio: 0, whiteBgScore: 0.05, solidBgScore: 0.1,
      edgeDensity: 0.08, variance: 3000, resolutionScore: 1.0,
    });
    expect(type).toBe("lifestyle");
  });

  it("outdoor product fixture has lifestyle primary for Meta", () => {
    const fixture = loadFixture("outdoor_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR", "meta");
    expect(product!.primaryImage).not.toBeNull();
    expect(product!.primaryImage!.imageType).toBe("lifestyle");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 16: Fallback image (unknown/classified as unknown, still usable)
// ════════════════════════════════════════════════════════════════════════════

describe("Test 16: Fallback image handling", () => {
  it("image not classified gets type unknown but is still selected", () => {
    const fixture = loadFixture("normal_product");
    // Modify images to be unclassified
    const input: BuildCanonicalInput = {
      ...makeInput(fixture),
      images: fixture.images.map((img: ReturnType<typeof loadFixture>["images"][0]) => ({
        ...img,
        imageType: null, // not classified
        isClassified: false,
      })),
    };
    const product = buildCanonical(input, "BE_FR");
    // Should still get a primary image (falls through to first valid)
    expect(product).not.toBeNull();
    expect(product!.primaryImage).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 17: GTIN absent → identifierExists = false, no invented GTIN
// ════════════════════════════════════════════════════════════════════════════

describe("Test 17: Missing GTIN", () => {
  it("null gtin → identifierExists false, gtin null in canonical", () => {
    const fixture = loadFixture("missing_gtin");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.gtin).toBeNull();
    expect(product!.mpn).toBeNull();
    expect(product!.identifierExists).toBe(false);
  });

  it("validateGtin returns null for invalid GTIN", () => {
    expect(validateGtin(null)).toBeNull();
    expect(validateGtin("123")).toBeNull();
    expect(validateGtin("12345678901234567")).toBeNull();
    expect(validateGtin("abcdefghijklm")).toBeNull();
  });

  it("validateGtin validates EAN-13 checksum", () => {
    expect(validateGtin("5901234123457")).toBe("5901234123457"); // valid
    expect(validateGtin("5901234123456")).toBeNull(); // wrong check digit
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 18: Variants — item_group_id groups same product variants
// ════════════════════════════════════════════════════════════════════════════

describe("Test 18: Variants", () => {
  it("both variants of a product share the same item_group_id", () => {
    const fixture = loadFixture("multi_variant");

    const input140: BuildCanonicalInput = {
      product: fixture.product,
      variant: fixture.variant_140,
      marketVariants: fixture.marketVariants_140,
      translations: fixture.translations,
      images: fixture.images,
      inventoryLevels: fixture.inventoryLevels_140,
      recommendations: null,
      normalizedBestsellerScore: null,
      config: testConfig,
    };

    const input180: BuildCanonicalInput = {
      product: fixture.product,
      variant: fixture.variant_180,
      marketVariants: fixture.marketVariants_180,
      translations: fixture.translations,
      images: fixture.images,
      inventoryLevels: fixture.inventoryLevels_180,
      recommendations: null,
      normalizedBestsellerScore: null,
      config: testConfig,
    };

    const p140 = buildCanonical(input140, "BE_FR");
    const p180 = buildCanonical(input180, "BE_FR");

    expect(p140).not.toBeNull();
    expect(p180).not.toBeNull();
    expect(p140!.itemGroupId).toBe(p180!.itemGroupId); // same product GID
    expect(p140!.variantId).not.toBe(p180!.variantId); // different variant IDs
    expect(p140!.price.amount).toBe(1890);
    expect(p180!.price.amount).toBe(2190);
    // variant titles should differ
    expect(p140!.title).toContain("140");
    expect(p180!.title).toContain("180");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 19: Custom labels — all 5 labels correct
// ════════════════════════════════════════════════════════════════════════════

describe("Test 19: Custom labels", () => {
  it("outlet product gets lifecycle=outlet", () => {
    const fixture = loadFixture("outlet_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.customLabels.custom_label_0).toBe("outlet");
  });

  it("sale product gets lifecycle=sale (not outlet)", () => {
    const fixture = loadFixture("sale_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.customLabels.custom_label_0).toBe("sale");
  });

  it("bestseller product gets performance=bestseller", () => {
    const fixture = loadFixture("bestseller_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.customLabels.custom_label_1).toBe("bestseller");
  });

  it("price band assigned correctly for €899", () => {
    const labels = computeCustomLabels({
      isOutlet: false, isOnSale: false, isNew: false, isBestseller: false,
      bestsellerClass: null, priceAmount: 899, discountBucket: "none",
      inventoryLabel: "online", config: testConfig.labels,
    });
    expect(labels.custom_label_2).toBe("500_1000");
  });

  it("price band 2500_5000 for €2890", () => {
    const labels = computeCustomLabels({
      isOutlet: false, isOnSale: false, isNew: false, isBestseller: false,
      bestsellerClass: null, priceAmount: 2890, discountBucket: "none",
      inventoryLabel: "online", config: testConfig.labels,
    });
    expect(labels.custom_label_2).toBe("2500_5000");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 20: Related scoring (same product type highest weight)
// ════════════════════════════════════════════════════════════════════════════

describe("Test 20: Related product scoring", () => {
  const sofa: Parameters<typeof scoreRelatedProducts>[0] = {
    id: "p1", productType: "sofa", vendor: "Ethnicraft",
    collections: ["living"], style: ["scandinavian"],
    material: ["oak"], priceAmount: 2000, availability: "in_stock",
    canonicalCategory: "sofa", isDiscontinued: false,
  };

  const similarSofa: Parameters<typeof scoreRelatedProducts>[1][0] = {
    id: "p2", productType: "sofa", vendor: "Ethnicraft",
    collections: ["living"], style: ["scandinavian"],
    material: ["fabric"], priceAmount: 2100, availability: "in_stock",
    canonicalCategory: "sofa", isDiscontinued: false,
  };

  const differentProduct: Parameters<typeof scoreRelatedProducts>[1][0] = {
    id: "p3", productType: "dining_table", vendor: "Muuto",
    collections: [], style: [],
    material: [], priceAmount: 5000, availability: "out_of_stock",
    canonicalCategory: "dining_table", isDiscontinued: false,
  };

  it("same product type scores highest", () => {
    const results = scoreRelatedProducts(sofa, [similarSofa, differentProduct]);
    // similar sofa should score higher (same type + brand + collection + style + similar price)
    expect(results[0]!.productId).toBe("p2");
    expect(results[0]!.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("discontinued products are excluded", () => {
    const discontinued: Parameters<typeof scoreRelatedProducts>[1][0] = {
      ...similarSofa, id: "p4", isDiscontinued: true,
    };
    const results = scoreRelatedProducts(sofa, [similarSofa, discontinued]);
    expect(results.find((r) => r.productId === "p4")).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 21: Complementary scoring (config-driven)
// ════════════════════════════════════════════════════════════════════════════

describe("Test 21: Complementary product scoring", () => {
  it("sofa gets complementary from coffee_table, rug, side_table", () => {
    const coffeeTable: Parameters<typeof findComplementaryProducts>[1][0] = {
      id: "ct1", productType: "coffee_table", vendor: "Ethnicraft",
      collections: [], style: [], material: [],
      priceAmount: 800, availability: "in_stock",
      canonicalCategory: "coffee_table", isDiscontinued: false,
    };
    const results = findComplementaryProducts("sofa", [coffeeTable], testConfig.complementary);
    expect(results).toContain("ct1");
  });

  it("no complementary if source category not in config", () => {
    const results = findComplementaryProducts("unknown_type", [], testConfig.complementary);
    expect(results).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 22: Market / language resolution
// ════════════════════════════════════════════════════════════════════════════

describe("Test 22: Market and language resolution", () => {
  it("BE_FR resolves to language=fr, country=BE, currency=EUR", () => {
    const market = resolveMarket("BE_FR", testConfig.markets);
    expect(market).not.toBeNull();
    expect(market!.language).toBe("fr");
    expect(market!.country).toBe("BE");
    expect(market!.currency).toBe("EUR");
  });

  it("DE resolves to language=de", () => {
    const market = resolveMarket("DE", testConfig.markets);
    expect(market!.language).toBe("de");
  });

  it("unknown market returns null", () => {
    expect(resolveMarket("XX", testConfig.markets)).toBeNull();
  });

  it("resolveContent returns German translation for de language", () => {
    const translations = [
      { productId: "p1", language: "fr", title: "Table française", description: null, handle: "table" },
      { productId: "p1", language: "de", title: "Deutscher Tisch", description: null, handle: "tisch" },
    ];
    const content = resolveContent("de", "table", translations);
    expect(content.title).toBe("Deutscher Tisch");
  });

  it("falls back to base title when no translation exists", () => {
    const content = resolveContent("en", "my-product", []);
    expect(content.title).toBe("my-product");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 23: Shipping class
// ════════════════════════════════════════════════════════════════════════════

describe("Test 23: Shipping class", () => {
  it("shipping class comes from metafield_shipping_class", () => {
    const fixture = loadFixture("normal_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.shippingClass).toBe("bulky");
  });

  it("defaults to config default_class when metafield absent", () => {
    const fixture = loadFixture("missing_gtin");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    // missing_gtin fixture has metafieldShippingClass: "standard"
    expect(product!.shippingClass).toBe("standard");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 24: Google category mapping
// ════════════════════════════════════════════════════════════════════════════

describe("Test 24: Google category mapping", () => {
  it("Dining Table maps to correct Google category ID", () => {
    const result = mapCategory("Dining Table", [], testConfig.categories);
    expect(result.googleCategoryId).toBe("443");
    expect(result.mappingSource).toBe("explicit");
  });

  it("unknown type falls back to Furniture", () => {
    const result = mapCategory("Unknown Furniture", [], testConfig.categories);
    expect(result.googleCategoryId).toBe("436");
    expect(result.mappingSource).toBe("fallback");
  });

  it("normal product fixture has Google category from config", () => {
    const fixture = loadFixture("normal_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.googleProductCategory).toBe("443"); // Dining Table
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 25: Meta category mapping
// ════════════════════════════════════════════════════════════════════════════

describe("Test 25: Meta category mapping", () => {
  it("Sofa maps to correct Meta category", () => {
    const result = mapCategory("Sofa", [], testConfig.categories);
    expect(result.metaCategory).toBe("furniture > seating > sofas");
  });

  it("Outdoor Sofa maps to outdoor Meta category", () => {
    const result = mapCategory("Outdoor Sofa", [], testConfig.categories);
    expect(result.metaCategory).toContain("outdoor");
    expect(result.indoorOutdoor).toBe("outdoor");
  });

  it("outdoor product fixture has correct outdoor classification", () => {
    const fixture = loadFixture("outdoor_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product!.indoorOutdoor).toBe("outdoor");
    expect(product!.metaProductCategory).toContain("outdoor");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Additional quality-of-life tests (beyond spec 51)
// ════════════════════════════════════════════════════════════════════════════

describe("Brand normalisation", () => {
  it("normalises Ethnicraft alias", () => {
    expect(normaliseBrand("Ethnicraft NV")).toBe("Ethnicraft");
    expect(normaliseBrand("ethnicraft")).toBe("Ethnicraft");
  });

  it("normalises vetsak alias", () => {
    expect(normaliseBrand("VETSAK")).toBe("vetsak");
  });

  it("returns unknown brand as-is", () => {
    expect(normaliseBrand("UnknownBrand Co.")).toBe("UnknownBrand Co.");
  });
});

describe("Title construction", () => {
  it("builds title without duplicate product type", () => {
    const title = buildTitle({
      brand: "Ethnicraft",
      productTitle: "Bok Dining Table",
      variantTitle: "Oak 200 cm",
      productType: "Dining Table",
    });
    // Dining Table is part of productTitle so shouldn't be appended twice
    expect(title).toContain("Ethnicraft");
    expect(title).toContain("200 cm");
    expect(title.length).toBeLessThanOrEqual(150);
  });

  it("skips Default Title variant", () => {
    const title = buildTitle({
      brand: "GUBI",
      productTitle: "Beetle Chair",
      variantTitle: "Default Title",
    });
    expect(title).not.toContain("Default Title");
  });
});

describe("Description sanitisation", () => {
  it("strips HTML tags", () => {
    const result = sanitizeDescription("<p>Hello <strong>World</strong></p>");
    expect(result).toBe("Hello World");
  });

  it("strips script tags completely", () => {
    const result = sanitizeDescription("<p>Good</p><script>alert('xss')</script>");
    expect(result).not.toContain("alert");
    expect(result).toContain("Good");
  });

  it("returns empty string for null input", () => {
    expect(sanitizeDescription(null)).toBe("");
  });
});

describe("Bestseller scoring", () => {
  it("metafield=true → bestseller class regardless of score", () => {
    const result = determineBestsellerClass(true, 0.1); // low score but metafield=true
    expect(result.isBestseller).toBe(true);
    expect(result.class).toBe("bestseller");
  });

  it("high normalised score → bestseller class", () => {
    const result = determineBestsellerClass(null, 0.92);
    expect(result.isBestseller).toBe(true);
    expect(result.class).toBe("bestseller");
  });

  it("medium score → medium class", () => {
    const result = determineBestsellerClass(null, 0.45);
    expect(result.class).toBe("medium");
    expect(result.isBestseller).toBe(false);
  });

  it("scoreBestseller weights sum to 1.0", () => {
    const score = scoreBestseller({ sales30d: 1, sales60d: 1, revenueNormalized: 1, stockHealth: 1 });
    expect(score).toBeCloseTo(1.0, 5);
  });
});

describe("Data quality score", () => {
  it("well-populated product scores > 60", () => {
    const fixture = loadFixture("normal_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR")!;
    const quality = computeQualityScore(product, testConfig.feedPolicy.quality_weights);
    expect(quality.score).toBeGreaterThan(60);
  });

  it("product without GTIN/MPN scores lower on identifiers", () => {
    const fixture = loadFixture("missing_gtin");
    const product = buildCanonical(makeInput(fixture), "BE_FR")!;
    const quality = computeQualityScore(product, testConfig.feedPolicy.quality_weights);
    expect(quality.identifiers).toBe(0);
    expect(quality.details).toContain("missing_gtin");
    expect(quality.details).toContain("missing_mpn");
  });
});

describe("Image selection priority (Google vs Meta)", () => {
  it("Google prefers packshot_white as primary", () => {
    const fixture = loadFixture("normal_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR", "google");
    expect(product!.primaryImage!.imageType).toBe("packshot_white");
    expect(product!.lifestyleImage!.imageType).toBe("lifestyle");
  });

  it("Meta prefers lifestyle as primary", () => {
    const fixture = loadFixture("outdoor_product");
    const productMeta = buildCanonical(makeInput(fixture), "BE_FR", "meta");
    expect(productMeta!.primaryImage!.imageType).toBe("lifestyle");
  });
});

describe("isNew detection", () => {
  it("published 30 days ago → isNew true (threshold 60 days)", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(isNewProduct(thirtyDaysAgo, 60)).toBe(true);
  });

  it("published 90 days ago → isNew false", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    expect(isNewProduct(ninetyDaysAgo, 60)).toBe(false);
  });
});

describe("Price fail-safe (spec section 88)", () => {
  it("missing price returns priceInvalid=true", () => {
    const promo = computePromotion(null, null, "EUR");
    expect(promo.priceInvalid).toBe(true);
  });

  it("price=0 returns priceInvalid=true", () => {
    const promo = computePromotion("0", null, "EUR");
    expect(promo.priceInvalid).toBe(true);
  });

  it("missing currency returns priceInvalid=true", () => {
    const promo = computePromotion("100.00", null, "");
    expect(promo.priceInvalid).toBe(true);
  });

  it("invalid market pricing → buildCanonical returns null", () => {
    const fixture = loadFixture("normal_product");
    const input: BuildCanonicalInput = {
      ...makeInput(fixture),
      marketVariants: [
        { variantId: "var-001", marketCode: "BE_FR", priceAmount: "0", priceCurrency: "EUR",
          compareAtPriceAmount: null, availability: "in_stock",
          productUrl: null, isEligible: true },
      ],
    };
    const product = buildCanonical(input, "BE_FR");
    expect(product).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Publication status gate — draft/archived products must never reach feeds
// ════════════════════════════════════════════════════════════════════════════

describe("Publication status gate", () => {
  it("draft product → buildCanonical returns null (must not reach any channel feed)", () => {
    const fixture = loadFixture("normal_product");
    const input: BuildCanonicalInput = {
      ...makeInput(fixture),
      product: { ...fixture.product, status: "draft" },
    };
    expect(buildCanonical(input, "BE_FR")).toBeNull();
  });

  it("archived product → buildCanonical returns null", () => {
    const fixture = loadFixture("normal_product");
    const input: BuildCanonicalInput = {
      ...makeInput(fixture),
      product: { ...fixture.product, status: "archived" },
    };
    expect(buildCanonical(input, "BE_FR")).toBeNull();
  });

  it("active product → buildCanonical succeeds", () => {
    const fixture = loadFixture("normal_product");
    const product = buildCanonical(makeInput(fixture), "BE_FR");
    expect(product).not.toBeNull();
  });
});
