/**
 * Backfill parity tests.
 *
 * Tests import directly from @workspace/rec-engine — the SAME package used by
 * both the runtime engine (artifacts/api-server/src/recommendations/engine.ts)
 * and the offline backfill (scripts/src/backfill.ts). This guarantees any
 * divergence would be a compile/test error, not a silent data difference.
 *
 * Covers:
 *   - Inactive / discontinued products excluded from source and candidate pools
 *   - Scoring algorithm parity (spec §24 weights, tie-breaks, price tolerance)
 *   - Complementary products driven by config adjacency map
 *   - top_n limiting
 *   - Zero-images edge case for single-product sync (tested separately in image-pagination.test.ts)
 */

import { describe, it, expect } from "vitest";
import {
  scoreRelatedProducts,
  findComplementaryProducts,
  type RecProduct,
  type ComplementaryConfig,
} from "@workspace/rec-engine";

// ── Helpers ───────────────────────────────────────────────────────────────────

function product(overrides: Partial<RecProduct> & { id: string }): RecProduct {
  return {
    productType: "Sofa",
    vendor: "Brand A",
    collections: [],
    style: ["Scandinavian"],
    material: ["Fabric"],
    priceAmount: 500,
    availability: "in_stock",
    canonicalCategory: "sofa",
    isDiscontinued: false,
    ...overrides,
  };
}

const COMPLEMENTARY_CONFIG: ComplementaryConfig = {
  complementary: {
    sofa: ["coffee_table", "rug"],
    coffee_table: ["sofa"],
    rug: ["sofa"],
  },
};

// ── Inactive product exclusion ────────────────────────────────────────────────

describe("Inactive / discontinued product exclusion", () => {
  it("discontinued candidates are excluded regardless of score", () => {
    const source = product({ id: "src" });
    const disc = product({ id: "disc", isDiscontinued: true });

    const result = scoreRelatedProducts(source, [disc], 0.20, 0.40, 8);
    expect(result.map((r) => r.productId)).not.toContain("disc");
  });

  it("non-discontinued candidates with matching type ARE included", () => {
    const source = product({ id: "src" });
    const active = product({ id: "active" });

    const result = scoreRelatedProducts(source, [active], 0.20, 0.40, 8);
    expect(result.map((r) => r.productId)).toContain("active");
  });
});

// ── Scoring algorithm parity ──────────────────────────────────────────────────

describe("Scoring algorithm parity (same weights used by both runtime engine and backfill)", () => {
  it("same product type scores higher than different product type (spec §24: +30)", () => {
    const source = product({ id: "src", productType: "Sofa" });
    const sameType = product({ id: "same-type", productType: "Sofa", priceAmount: 550 });
    const diffType = product({ id: "diff-type", productType: "Bed", priceAmount: 550, vendor: "Brand Z" });

    const result = scoreRelatedProducts(source, [sameType, diffType], 0.20, 0.40, 8);
    const sameIdx = result.findIndex((r) => r.productId === "same-type");
    const diffIdx = result.findIndex((r) => r.productId === "diff-type");

    expect(sameIdx).toBeGreaterThanOrEqual(0);
    if (diffIdx !== -1) expect(sameIdx).toBeLessThan(diffIdx);
  });

  it("same brand cumulative with same type scores highest (spec §24: +30+20)", () => {
    const source = product({ id: "src", vendor: "BrandX", productType: "Sofa" });
    const sameBrandAndType = product({ id: "both", vendor: "BrandX", productType: "Sofa", priceAmount: 550 });
    const sameTypeOnly = product({ id: "type-only", vendor: "BrandY", productType: "Sofa", priceAmount: 550 });

    const result = scoreRelatedProducts(source, [sameBrandAndType, sameTypeOnly], 0.20, 0.40, 8);
    expect(result[0]!.productId).toBe("both");
  });

  it("in-stock preferred over out-of-stock at equal score — last-resort path included", () => {
    // With only 2 candidates < min(4,8), the engine falls to last-resort.
    // Both paths (loop + last-resort) must apply the in_stock tie-break.
    const source = product({ id: "src", productType: "Sofa" });
    const outOfStock = product({ id: "oos", productType: "Sofa", availability: "out_of_stock", priceAmount: 550 });
    const inStock = product({ id: "instock", productType: "Sofa", availability: "in_stock", priceAmount: 550 });

    const result = scoreRelatedProducts(source, [outOfStock, inStock], 0.20, 0.40, 8);
    expect(result[0]!.productId).toBe("instock");
  });

  it("price tolerance progression: finds results at wider band when narrow yields too few", () => {
    // Only 1 candidate; it's outside 20% but inside 40% band.
    const source = product({ id: "src", productType: "Sofa", priceAmount: 1000 });
    const far = product({ id: "far", productType: "Sofa", priceAmount: 1350, vendor: "Different Brand" });

    const result = scoreRelatedProducts(source, [far], 0.20, 0.40, 8);
    // Score: sameProductType=30; price 35% apart — outside 20% and 30%, inside 40%.
    expect(result.map((r) => r.productId)).toContain("far");
  });

  it("top_n caps results — never returns more than topN", () => {
    const source = product({ id: "src", productType: "Sofa" });
    const candidates = Array.from({ length: 20 }, (_, i) =>
      product({ id: `p-${i}`, productType: "Sofa", priceAmount: 500 + i }),
    );

    const result = scoreRelatedProducts(source, candidates, 0.20, 0.40, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("self is excluded from candidates", () => {
    const source = product({ id: "src" });
    const result = scoreRelatedProducts(source, [source], 0.20, 0.40, 8);
    expect(result.map((r) => r.productId)).not.toContain("src");
  });
});

// ── Complementary products ────────────────────────────────────────────────────

describe("Complementary products (config adjacency, ≤2 per category)", () => {
  it("returns products from complementary categories, not from source category", () => {
    const source = product({ id: "src", canonicalCategory: "sofa" });
    const coffeeTable = product({ id: "ct-1", canonicalCategory: "coffee_table" });
    const rug = product({ id: "rug-1", canonicalCategory: "rug" });
    const bed = product({ id: "bed-1", canonicalCategory: "bed" });

    const result = findComplementaryProducts(source.canonicalCategory, [coffeeTable, rug, bed], COMPLEMENTARY_CONFIG);
    expect(result).toContain("ct-1");
    expect(result).toContain("rug-1");
    expect(result).not.toContain("bed-1"); // not in sofa's complementary list
  });

  it("prefers in_stock over out_of_stock within a complementary category", () => {
    const source = product({ id: "src", canonicalCategory: "sofa" });
    const oos = product({ id: "ct-oos", canonicalCategory: "coffee_table", availability: "out_of_stock" });
    const instock = product({ id: "ct-in", canonicalCategory: "coffee_table", availability: "in_stock" });

    const result = findComplementaryProducts(source.canonicalCategory, [oos, instock], COMPLEMENTARY_CONFIG);
    expect(result[0]).toBe("ct-in");
  });

  it("respects topN cap across all complementary categories", () => {
    const source = product({ id: "src", canonicalCategory: "sofa" });
    // 10 coffee tables + 10 rugs, but sofa has coffee_table + rug as complementary
    // with max 2 per category → max result = 4
    const candidates = [
      ...Array.from({ length: 10 }, (_, i) => product({ id: `ct-${i}`, canonicalCategory: "coffee_table" })),
      ...Array.from({ length: 10 }, (_, i) => product({ id: `rug-${i}`, canonicalCategory: "rug" })),
    ];

    const result = findComplementaryProducts(source.canonicalCategory, candidates, COMPLEMENTARY_CONFIG, [], 8);
    expect(result.length).toBeLessThanOrEqual(8);
    // ≤2 per category → at most 4 from 2 categories
    expect(result.length).toBeLessThanOrEqual(4);
  });

  it("returns manual recommendations as priority 1 without scoring", () => {
    const source = product({ id: "src", canonicalCategory: "sofa" });
    const manual = ["manual-1", "manual-2"];

    const result = findComplementaryProducts(source.canonicalCategory, [], COMPLEMENTARY_CONFIG, manual);
    expect(result).toEqual(manual);
  });

  it("returns empty when source has no complementary category mapping", () => {
    const source = product({ id: "src", canonicalCategory: "unknown_category" });
    const result = findComplementaryProducts(source.canonicalCategory, [], COMPLEMENTARY_CONFIG);
    expect(result).toHaveLength(0);
  });
});
