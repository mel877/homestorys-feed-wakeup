/**
 * Category mapper tests — @workspace/rec-engine/src/category-mapper.ts
 *
 * Covers:
 *   - Explicit mapping (case-insensitive exact match)
 *   - Fuzzy matching (substring + word overlap)
 *   - Fallback category when no mapping found
 *   - Per-channel metafield overrides: Google override does NOT clear Meta,
 *     Meta override does NOT clear Google, canonicalCategory is always from pipeline
 *   - Collection-based mapping
 *
 * Both the runtime engine (artifacts/api-server/src/categories/mapper.ts) and
 * the offline backfill (scripts/src/backfill.ts) import from @workspace/rec-engine,
 * so these tests validate both paths simultaneously.
 */

import { describe, it, expect } from "vitest";
import { mapCategory } from "@workspace/rec-engine";
import type { RecCategoriesConfig } from "@workspace/rec-engine";

// ── Fixture ────────────────────────────────────────────────────────────────────

const config: RecCategoriesConfig = {
  fallback_google_category_id: "436",
  fallback_google_category_label: "Furniture",
  fallback_meta_category: "Furniture > Other",
  mappings: [
    {
      shopify_type: "Sofa",
      canonical: "sofa",
      google_category_id: "6464",
      google_category_label: "Sofas",
      meta_category: "Furniture > Sofas",
      indoor_outdoor: "indoor",
    },
    {
      shopify_type: "Coffee Table",
      canonical: "coffee_table",
      google_category_id: "7120",
      google_category_label: "Coffee Tables",
      meta_category: "Furniture > Tables > Coffee Tables",
      indoor_outdoor: "indoor",
    },
    {
      shopify_type: "Outdoor Sofa",
      canonical: "outdoor_sofa",
      google_category_id: "6477",
      google_category_label: "Outdoor Sofas",
      meta_category: "Patio > Furniture > Sofas",
      indoor_outdoor: "outdoor",
    },
  ],
};

// ── Explicit mapping ───────────────────────────────────────────────────────────

describe("Explicit mapping", () => {
  it("maps an exact product_type to its canonical category", () => {
    const result = mapCategory("Sofa", [], config);
    expect(result.canonicalCategory).toBe("sofa");
    expect(result.googleCategoryId).toBe("6464");
    expect(result.metaCategory).toBe("Furniture > Sofas");
    expect(result.mappingSource).toBe("explicit");
  });

  it("is case-insensitive for exact matching", () => {
    const result = mapCategory("sofa", [], config);
    expect(result.canonicalCategory).toBe("sofa");
  });

  it("maps Coffee Table with spaces", () => {
    const result = mapCategory("Coffee Table", [], config);
    expect(result.canonicalCategory).toBe("coffee_table");
  });
});

// ── Fuzzy matching ────────────────────────────────────────────────────────────

describe("Fuzzy matching", () => {
  it("maps a product type that contains a known key (suffix case)", () => {
    // 'Sofa' is a key; 'Corner Sofa' contains it → fuzzy match
    const result = mapCategory("Corner Sofa", [], config);
    expect(result.canonicalCategory).toBe("sofa");
    expect(result.mappingSource).toBe("fuzzy");
    expect(result.diagnostic).toContain("Fuzzy match");
  });

  it("maps a product type that is contained by a known key (prefix case)", () => {
    // 'Outdoor Sofa' is a key; querying just 'Outdoor' — 'Outdoor' is in 'Outdoor Sofa'
    const result = mapCategory("Outdoor", [], config);
    // 'Outdoor' is a substring of key 'Outdoor Sofa' → fuzzy
    expect(result.mappingSource).toBe("fuzzy");
    expect(result.canonicalCategory).toBe("outdoor_sofa");
  });

  it("falls back to fallback category when no fuzzy match found", () => {
    const result = mapCategory("Completely Unknown Type XYZ", [], config);
    expect(result.mappingSource).toBe("fallback");
    expect(result.canonicalCategory).toBeNull();
    expect(result.googleCategoryId).toBe("436"); // fallback
  });
});

// ── Fallback ───────────────────────────────────────────────────────────────────

describe("Fallback category", () => {
  it("uses fallback when product_type is null", () => {
    const result = mapCategory(null, [], config);
    expect(result.mappingSource).toBe("fallback");
    expect(result.googleCategoryId).toBe("436");
    expect(result.metaCategory).toBe("Furniture > Other");
  });

  it("uses fallback when product_type is undefined", () => {
    const result = mapCategory(undefined, [], config);
    expect(result.mappingSource).toBe("fallback");
  });

  it("includes diagnostic when product_type is set but unmapped", () => {
    const result = mapCategory("Hammock", [], config);
    expect(result.diagnostic).toContain("No mapping for product_type");
  });
});

// ── Collection-based mapping ───────────────────────────────────────────────────

describe("Collection-based mapping", () => {
  it("maps via collection title when product_type has no match", () => {
    const result = mapCategory("Seating", ["Sofa"], config);
    // "Sofa" collection matches explicitly; "Seating" product type has no mapping
    expect(result.canonicalCategory).toBe("sofa");
    expect(result.mappingSource).toBe("collection");
  });

  it("product_type explicit match takes priority over collection", () => {
    // product_type = "Sofa" (explicit), collection = "Coffee Table"
    const result = mapCategory("Sofa", ["Coffee Table"], config);
    expect(result.canonicalCategory).toBe("sofa");
    expect(result.mappingSource).toBe("explicit");
  });
});

// ── Per-channel metafield overrides ───────────────────────────────────────────

describe("Per-channel metafield overrides — no cross-channel clearing", () => {
  it("Google override replaces googleCategoryId but NOT metaCategory", () => {
    const result = mapCategory("Sofa", [], config, "custom-google-id-123", null);
    expect(result.googleCategoryId).toBe("custom-google-id-123");
    // Meta channel comes from normal pipeline (Sofa → "Furniture > Sofas")
    expect(result.metaCategory).toBe("Furniture > Sofas");
    // canonicalCategory is always from pipeline, not null
    expect(result.canonicalCategory).toBe("sofa");
  });

  it("Google override clears googleCategoryLabel (free-form ID, label unknown)", () => {
    const result = mapCategory("Sofa", [], config, "custom-google-id-123", null);
    expect(result.googleCategoryLabel).toBeNull();
  });

  it("Meta override replaces metaCategory but NOT googleCategoryId", () => {
    const result = mapCategory("Sofa", [], config, null, "custom-meta-category");
    expect(result.metaCategory).toBe("custom-meta-category");
    // Google channel comes from normal pipeline (Sofa → "6464")
    expect(result.googleCategoryId).toBe("6464");
    expect(result.googleCategoryLabel).toBe("Sofas");
    // canonicalCategory is always from pipeline
    expect(result.canonicalCategory).toBe("sofa");
  });

  it("both overrides applied simultaneously — each channel gets its override", () => {
    const result = mapCategory("Sofa", [], config, "g-override", "m-override");
    expect(result.googleCategoryId).toBe("g-override");
    expect(result.metaCategory).toBe("m-override");
    expect(result.canonicalCategory).toBe("sofa"); // from pipeline
  });

  it("override on fuzzy-matched product preserves canonicalCategory from fuzzy match", () => {
    // "Corner Sofa" fuzzy matches to "sofa"; Google override applied on top
    const result = mapCategory("Corner Sofa", [], config, "g-override", null);
    expect(result.canonicalCategory).toBe("sofa"); // from fuzzy pipeline
    expect(result.googleCategoryId).toBe("g-override"); // overridden
    expect(result.metaCategory).toBe("Furniture > Sofas"); // from fuzzy pipeline
  });

  it("override on fallback product — canonicalCategory stays null (no pipeline match)", () => {
    const result = mapCategory("Unknown", [], config, "g-override", null);
    expect(result.canonicalCategory).toBeNull(); // fallback returns null canonical
    expect(result.googleCategoryId).toBe("g-override");
    expect(result.metaCategory).toBe("Furniture > Other"); // fallback meta preserved
  });
});
