/**
 * @workspace/rec-engine — pure recommendation scoring functions.
 *
 * Shared between:
 *   - artifacts/api-server/src/recommendations/engine.ts (runtime engine)
 *   - scripts/src/backfill.ts (offline backfill)
 *
 * Both consumers must import from here. Any change to scoring weights or
 * algorithm MUST be made here and takes effect in both paths simultaneously.
 * Do NOT copy-paste logic into either consumer.
 *
 * Weights (spec §24):
 *   sameProductType  +30
 *   sameBrand        +20
 *   sameCollection   +20
 *   sameStyle        +10
 *   sameMaterial     +10
 *   similarPrice     +10 (within tolerance %)
 */

// Re-export the category mapper so both the runtime engine and offline backfill
// use the identical implementation.
export {
  mapCategory,
  type CategoryResult,
  type CategoryMapping,
  type CategoriesConfig as RecCategoriesConfig,
} from "./category-mapper";

export interface RecProduct {
  id: string;
  productType: string | null;
  vendor: string | null;
  collections: string[];
  style: string[];
  material: string[];
  priceAmount: number | null;
  availability: string; // "in_stock" | "backorder" | "out_of_stock" | "discontinued"
  canonicalCategory: string | null;
  isDiscontinued: boolean;
}

export interface ScoredCandidate {
  productId: string;
  score: number;
  reasons: string[];
}

export interface ComplementaryConfig {
  complementary: Record<string, string[]>;
}

/** Score weights per spec §24. */
export const RECOMMENDATION_SCORES = {
  sameProductType: 30,
  sameBrand: 20,
  sameCollection: 20,
  sameStyle: 10,
  sameMaterial: 10,
  similarPrice: 10,
} as const;

/** Score a single candidate against the source product. */
export function scoreCandidate(
  source: RecProduct,
  candidate: RecProduct,
  priceTolerance: number,
): ScoredCandidate {
  let score = 0;
  const reasons: string[] = [];

  // Same product type (+30)
  if (
    source.productType &&
    candidate.productType &&
    source.productType.toLowerCase() === candidate.productType.toLowerCase()
  ) {
    score += RECOMMENDATION_SCORES.sameProductType;
    reasons.push("same_product_type");
  }

  // Same brand (+20)
  if (
    source.vendor &&
    candidate.vendor &&
    source.vendor.toLowerCase() === candidate.vendor.toLowerCase()
  ) {
    score += RECOMMENDATION_SCORES.sameBrand;
    reasons.push("same_brand");
  }

  // Same collection (+20, first match)
  if (source.collections.length > 0 && candidate.collections.length > 0) {
    const sourceSet = new Set(source.collections.map((c) => c.toLowerCase()));
    if (candidate.collections.some((c) => sourceSet.has(c.toLowerCase()))) {
      score += RECOMMENDATION_SCORES.sameCollection;
      reasons.push("same_collection");
    }
  }

  // Same style (+10)
  if (source.style.length > 0 && candidate.style.length > 0) {
    const sourceSet = new Set(source.style.map((s) => s.toLowerCase()));
    if (candidate.style.some((s) => sourceSet.has(s.toLowerCase()))) {
      score += RECOMMENDATION_SCORES.sameStyle;
      reasons.push("same_style");
    }
  }

  // Same material (+10)
  if (source.material.length > 0 && candidate.material.length > 0) {
    const sourceSet = new Set(source.material.map((m) => m.toLowerCase()));
    if (candidate.material.some((m) => sourceSet.has(m.toLowerCase()))) {
      score += RECOMMENDATION_SCORES.sameMaterial;
      reasons.push("same_material");
    }
  }

  // Similar price (+10, within tolerance %)
  if (
    source.priceAmount !== null &&
    source.priceAmount > 0 &&
    candidate.priceAmount !== null &&
    candidate.priceAmount > 0
  ) {
    const ratio = Math.abs(source.priceAmount - candidate.priceAmount) / source.priceAmount;
    if (ratio <= priceTolerance) {
      score += RECOMMENDATION_SCORES.similarPrice;
      reasons.push("similar_price");
    }
  }

  return { productId: candidate.id, score, reasons };
}

/**
 * Comparator for ScoredCandidate: descending score, then prefer in_stock.
 * Pass the original candidates array for availability lookup.
 */
function rankComparator(
  a: ScoredCandidate,
  b: ScoredCandidate,
  candidates: RecProduct[],
): number {
  if (b.score !== a.score) return b.score - a.score;
  const aStock = candidates.find((c) => c.id === a.productId)?.availability === "in_stock" ? 1 : 0;
  const bStock = candidates.find((c) => c.id === b.productId)?.availability === "in_stock" ? 1 : 0;
  return bStock - aStock;
}

/**
 * Score related product candidates against the source.
 *
 * Tries progressively wider price bands until ≥ min(4, topN) results are found.
 * Falls back to returning best-scored regardless of minimum.
 * Secondary sort: prefer in_stock at equal scores (applied in both main loop AND last resort).
 */
export function scoreRelatedProducts(
  source: RecProduct,
  candidates: RecProduct[],
  priceTolerance = 0.20,
  maxPriceTolerance = 0.40,
  topN = 8,
): ScoredCandidate[] {
  const eligible = candidates.filter(
    (c) => c.id !== source.id && !c.isDiscontinued,
  );

  for (const tolerance of [priceTolerance, 0.30, maxPriceTolerance]) {
    const ranked = eligible
      .map((c) => scoreCandidate(source, c, tolerance))
      .filter((s) => s.score > 0)
      .sort((a, b) => rankComparator(a, b, candidates))
      .slice(0, topN);

    if (ranked.length >= Math.min(4, topN)) return ranked;
  }

  // Last resort: return best-scored regardless of minimum count.
  // in_stock tie-break is applied here too (rankComparator) — mirrors the main loop.
  return eligible
    .map((c) => scoreCandidate(source, c, maxPriceTolerance))
    .filter((s) => s.score > 0)
    .sort((a, b) => rankComparator(a, b, candidates))
    .slice(0, topN);
}

/**
 * Find complementary product IDs from config mapping.
 *
 * Priority:
 *   1. Manual Shopify recommendations (pass in manualRecommendations)
 *   2. Config adjacency map (complementary.yaml)
 *   3. Empty (no complementary categories found)
 *
 * Secondary sort: prefer in_stock; take ≤2 per complementary category.
 */
export function findComplementaryProducts(
  sourceCanonicalCategory: string | null,
  allProducts: RecProduct[],
  config: ComplementaryConfig,
  manualRecommendations: string[] = [],
  topN = 8,
): string[] {
  if (manualRecommendations.length > 0) return manualRecommendations.slice(0, topN);

  if (!sourceCanonicalCategory) return [];

  const targetCategories = config.complementary[sourceCanonicalCategory] ?? [];
  if (targetCategories.length === 0) return [];

  const result: string[] = [];
  const seen = new Set<string>();

  for (const target of targetCategories) {
    const matches = allProducts
      .filter((p) => p.canonicalCategory === target && !p.isDiscontinued && !seen.has(p.id))
      .sort(
        (a, b) =>
          (b.availability === "in_stock" ? 1 : 0) -
          (a.availability === "in_stock" ? 1 : 0),
      );

    for (const m of matches.slice(0, 2)) {
      if (result.length < topN) {
        result.push(m.id);
        seen.add(m.id);
      }
    }
  }

  return result;
}
