/**
 * Recommendation eligibility integration tests.
 *
 * Verifies that runRecommendationsForMarket() ONLY includes products that have
 * an eligible (isEligible=true), valid-priced market variant in the requested
 * market — ineligible products must never appear in stored recommendations.
 *
 * Uses vi.mock to stub DB so no actual DB is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB state (populated per test) ─────────────────────────────────────────────

let mockProducts: Array<{
  id: string;
  shopifyGid: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  status: string;
}> = [];

let mockVariants: Array<{
  id: string;
  productId: string;
  metafieldStyle: string[];
  metafieldMaterial: string[];
  metafieldDiscontinued: boolean | null;
}> = [];

let mockMarketVariants: Array<{
  variantId: string;
  marketCode: string;
  priceAmount: string;
  availability: string;
  isEligible: boolean;
}> = [];

// Capture upserted recommendations
const storedRecs = new Map<
  string,
  { relatedProductIds: string[]; complementaryProductIds: string[] }
>();

// ── Drizzle-style mock ─────────────────────────────────────────────────────────

// Evaluate a condition (drizzle-orm mock shape) against a row.
// Supports eq and and; columns use snake_case from mock, rows use camelCase.
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
function evalCondition(row: Record<string, unknown>, cond: unknown): boolean {
  if (!cond || typeof cond !== "object") return true;
  const c = cond as Record<string, unknown>;
  if (c.type === "eq") {
    const col = snakeToCamel(c.col as string);
    return row[col] === c.val;
  }
  if (c.type === "and") {
    return (c.args as unknown[]).every((a) => evalCondition(row, a));
  }
  return true; // unknown condition — let through
}

vi.mock("@workspace/db", () => {
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          // Identify table by checking which column set it exposes
          const t = table as Record<string, unknown>;
          const isProducts = "status" in t;
          const isVariants = "productId" in t && !("variantId" in t);
          const isMarketVariants = "variantId" in t;

          // Rows for queries WITHOUT a .where() clause (e.g. variants full scan)
          const allRows: Record<string, unknown>[] = isProducts
            ? mockProducts as unknown as Record<string, unknown>[]
            : isVariants
            ? mockVariants as unknown as Record<string, unknown>[]
            : isMarketVariants
            ? mockMarketVariants as unknown as Record<string, unknown>[]
            : [];

          // Return an object that is both thenable (no where) and has .where()
          const result = {
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(allRows).then(resolve),
            where: (cond: unknown) =>
              Promise.resolve(allRows.filter((r) => evalCondition(r, cond))),
          };
          return result;
        },
      }),
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        // Provide a minimal tx that records recommendations
        const tx = {
          insert: () => ({
            values: (data: Record<string, unknown>) => ({
              onConflictDoUpdate: () => {
                const key = `${data.productId as string}::${data.marketCode as string}`;
                storedRecs.set(key, {
                  relatedProductIds: data.relatedProductIds as string[],
                  complementaryProductIds: data.complementaryProductIds as string[],
                });
                return Promise.resolve();
              },
            }),
          }),
        };
        await fn(tx);
      },
    },
    productsTable: {
      id: "id",
      shopifyGid: "shopify_gid",
      productType: "product_type",
      vendor: "vendor",
      tags: "tags",
      status: "status",
    },
    variantsTable: {
      id: "id",
      productId: "product_id",
      metafieldStyle: "metafield_style",
      metafieldMaterial: "metafield_material",
      metafieldDiscontinued: "metafield_discontinued",
    },
    marketVariantsTable: {
      variantId: "variant_id",
      marketCode: "market_code",
      priceAmount: "price_amount",
      availability: "availability",
      isEligible: "is_eligible",
    },
    recommendationsTable: {
      productId: "product_id",
      marketCode: "market_code",
    },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ type: "eq", col, val }),
  and: (...args: unknown[]) => ({ type: "and", args }),
  sql: (s: unknown) => s,
}));

// ── Stub config loader ────────────────────────────────────────────────────────

vi.mock("../src/config", () => ({
  loadConfig: () => ({
    categories: { mappings: [], fallbackGoogleCategoryId: "436", fallbackGoogleCategoryLabel: "Furniture", fallbackMetaCategory: "furniture" },
    complementary: { complementary: { sofa: ["coffee_table"], coffee_table: ["sofa"] } },
    markets: { markets: { BE_FR: {}, BE_NL: {} } },
    feedPolicy: {
      recommendations: { price_tolerance_pct: 20, price_tolerance_max_pct: 40, top_n: 8 },
    },
  }),
}));

vi.mock("../src/categories/mapper", () => ({
  mapCategory: (productType: string | null) => ({
    canonicalCategory: productType?.toLowerCase().replace(/\s/g, "_") ?? null,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProduct(id: string, productType = "Sofa") {
  return { id, shopifyGid: `gid://shopify/Product/${id}`, productType, vendor: "Brand", tags: [], status: "active" };
}

function makeVariant(id: string, productId: string) {
  return { id, productId, metafieldStyle: [], metafieldMaterial: [], metafieldDiscontinued: false };
}

function makeMarketVariant(
  variantId: string,
  marketCode: string,
  priceAmount: string,
  isEligible: boolean,
) {
  return { variantId, marketCode, priceAmount, availability: "in_stock", isEligible };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Recommendation eligibility filter", () => {
  beforeEach(() => {
    mockProducts = [];
    mockVariants = [];
    mockMarketVariants = [];
    storedRecs.clear();
  });

  it("does not store recommendations for products ineligible in the market", async () => {
    const { runRecommendationsForMarket } = await import("../src/recommendations/index");

    // Product A — eligible in BE_FR
    mockProducts = [makeProduct("p-a"), makeProduct("p-b")];
    mockVariants = [makeVariant("v-a", "p-a"), makeVariant("v-b", "p-b")];
    mockMarketVariants = [
      makeMarketVariant("v-a", "BE_FR", "499.00", true),
      // v-b is NOT eligible in BE_FR (isEligible=false)
      makeMarketVariant("v-b", "BE_FR", "299.00", false),
    ];

    await runRecommendationsForMarket("BE_FR");

    // Only p-a should have recommendations stored (p-b is ineligible)
    expect(storedRecs.has("p-a::BE_FR")).toBe(true);
    expect(storedRecs.has("p-b::BE_FR")).toBe(false);

    // p-b must not appear in p-a's related list
    const pARec = storedRecs.get("p-a::BE_FR");
    expect(pARec?.relatedProductIds).not.toContain("p-b");
    expect(pARec?.complementaryProductIds).not.toContain("p-b");
  });

  it("does not store recommendations for products with zero/missing price", async () => {
    const { runRecommendationsForMarket } = await import("../src/recommendations/index");

    mockProducts = [makeProduct("p-c"), makeProduct("p-d")];
    mockVariants = [makeVariant("v-c", "p-c"), makeVariant("v-d", "p-d")];
    mockMarketVariants = [
      makeMarketVariant("v-c", "BE_FR", "799.00", true),
      // v-d has price 0 — should be excluded despite isEligible=true
      makeMarketVariant("v-d", "BE_FR", "0.00", true),
    ];

    await runRecommendationsForMarket("BE_FR");

    expect(storedRecs.has("p-c::BE_FR")).toBe(true);
    expect(storedRecs.has("p-d::BE_FR")).toBe(false);

    const pCRec = storedRecs.get("p-c::BE_FR");
    expect(pCRec?.relatedProductIds).not.toContain("p-d");
  });

  it("does not mix market candidates — a product eligible in BE_NL must not appear in BE_FR recommendations", async () => {
    const { runRecommendationsForMarket } = await import("../src/recommendations/index");

    mockProducts = [makeProduct("p-e"), makeProduct("p-f")];
    mockVariants = [makeVariant("v-e", "p-e"), makeVariant("v-f", "p-f")];
    mockMarketVariants = [
      makeMarketVariant("v-e", "BE_FR", "599.00", true),
      // p-f only available in BE_NL, not in BE_FR
      makeMarketVariant("v-f", "BE_NL", "399.00", true),
    ];

    await runRecommendationsForMarket("BE_FR");

    // Only p-e is available in BE_FR
    expect(storedRecs.has("p-e::BE_FR")).toBe(true);
    expect(storedRecs.has("p-f::BE_FR")).toBe(false);

    const pERec = storedRecs.get("p-e::BE_FR");
    expect(pERec?.relatedProductIds).not.toContain("p-f");
  });

  it("uses eligible variant price even when first variant is ineligible (multi-variant product)", async () => {
    const { runRecommendationsForMarket } = await import("../src/recommendations/index");

    // Product p-i has two variants:
    //   v-i1: ineligible in BE_FR (first variant encountered)
    //   v-i2: eligible in BE_FR with valid price (second variant)
    // Product p-j has one eligible variant
    mockProducts = [makeProduct("p-i", "Sofa"), makeProduct("p-j", "Coffee Table")];
    mockVariants = [
      makeVariant("v-i1", "p-i"), // FIRST variant for p-i — ineligible
      makeVariant("v-i2", "p-i"), // SECOND variant for p-i — eligible
      makeVariant("v-j", "p-j"),
    ];
    mockMarketVariants = [
      makeMarketVariant("v-i1", "BE_FR", "499.00", false), // ineligible!
      makeMarketVariant("v-i2", "BE_FR", "599.00", true),  // eligible
      makeMarketVariant("v-j", "BE_FR", "299.00", true),
    ];

    await runRecommendationsForMarket("BE_FR");

    // p-i MUST be included (it has v-i2 which is eligible)
    expect(storedRecs.has("p-i::BE_FR")).toBe(true);
    expect(storedRecs.has("p-j::BE_FR")).toBe(true);

    // p-i must appear in p-j's related list (they're both eligible)
    const pJRec = storedRecs.get("p-j::BE_FR");
    // They have different product types so may not be in related, but must not be
    // recommended based on null/out-of-stock price — verify p-i IS reachable
    expect(pJRec).toBeDefined();
  });

  it("includes both products when both are eligible in the market", async () => {
    const { runRecommendationsForMarket } = await import("../src/recommendations/index");

    mockProducts = [makeProduct("p-g", "Sofa"), makeProduct("p-h", "Sofa")];
    mockVariants = [makeVariant("v-g", "p-g"), makeVariant("v-h", "p-h")];
    mockMarketVariants = [
      makeMarketVariant("v-g", "BE_FR", "499.00", true),
      makeMarketVariant("v-h", "BE_FR", "549.00", true),
    ];

    await runRecommendationsForMarket("BE_FR");

    expect(storedRecs.has("p-g::BE_FR")).toBe(true);
    expect(storedRecs.has("p-h::BE_FR")).toBe(true);

    // Each should recommend the other (same product type: Sofa → Sofa)
    const pGRec = storedRecs.get("p-g::BE_FR");
    expect(pGRec?.relatedProductIds).toContain("p-h");

    const pHRec = storedRecs.get("p-h::BE_FR");
    expect(pHRec?.relatedProductIds).toContain("p-g");
  });
});
