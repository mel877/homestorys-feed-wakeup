/**
 * Bestseller scoring — spec section 18.
 *
 * Priority:
 * 1. feed.bestseller metafield (explicit override)
 * 2. Order-metrics scoring (if read_orders scope available)
 * 3. No qualification (class = null)
 *
 * Score formula:
 *   score = sales_30d * 0.55 + sales_60d * 0.20 + revenue_normalized * 0.15 + stock_health * 0.10
 *
 * Normalised by category. Classes: bestseller | high | medium | low
 * Recalculated nightly via backfill script.
 */

import type { BestsellerClass } from "../canonical/types";

export interface BestsellerMetrics {
  /** Units sold in last 30 days. */
  sales30d: number;
  /** Units sold in last 60 days (cumulative). */
  sales60d: number;
  /** Revenue normalised 0-1 (relative to category max). */
  revenueNormalized: number;
  /** Stock health 0-1: 1 = well-stocked, 0 = out of stock. */
  stockHealth: number;
}

export interface BestsellerWeights {
  sales30d: number;
  sales60d: number;
  revenueNormalized: number;
  stockHealth: number;
}

const DEFAULT_WEIGHTS: BestsellerWeights = {
  sales30d: 0.55,
  sales60d: 0.20,
  revenueNormalized: 0.15,
  stockHealth: 0.10,
};

// Percentile thresholds for class assignment (after category normalisation)
const CLASS_THRESHOLDS = {
  bestseller: 0.85, // top 15%
  high: 0.60,       // 60-85th percentile
  medium: 0.30,     // 30-60th percentile
  // below 0.30 = low
};

/**
 * Determine bestseller class for a variant.
 *
 * @param metafieldOverride - feed.bestseller metafield value (takes priority)
 * @param normalizedScore - score 0-1, computed from scoreBestseller + normalised by category
 */
export function determineBestsellerClass(
  metafieldOverride: boolean | null | undefined,
  normalizedScore: number | null,
): { isBestseller: boolean; class: BestsellerClass | null } {
  // Priority 1: explicit metafield override
  if (metafieldOverride === true) {
    return { isBestseller: true, class: "bestseller" };
  }

  // Priority 2: scoring
  if (normalizedScore !== null) {
    const cls = assignClass(normalizedScore);
    return { isBestseller: cls === "bestseller", class: cls };
  }

  // Priority 3: no data
  return { isBestseller: false, class: null };
}

/**
 * Compute raw bestseller score from order metrics.
 * Score is NOT normalised — must be normalised per-category before class assignment.
 */
export function scoreBestseller(
  metrics: BestsellerMetrics,
  weights: BestsellerWeights = DEFAULT_WEIGHTS,
): number {
  return (
    metrics.sales30d * weights.sales30d +
    metrics.sales60d * weights.sales60d +
    metrics.revenueNormalized * weights.revenueNormalized +
    metrics.stockHealth * weights.stockHealth
  );
}

/**
 * Normalise an array of raw scores to 0-1 range within a category group.
 * Returns a Map<variantId, normalizedScore>.
 */
export function normaliseByCategoryScores(
  scores: Map<string, { score: number; category: string }>,
): Map<string, number> {
  // Group by category
  const byCategory = new Map<string, Array<{ id: string; score: number }>>();
  for (const [id, { score, category }] of scores) {
    const list = byCategory.get(category) ?? [];
    list.push({ id, score });
    byCategory.set(category, list);
  }

  const normalised = new Map<string, number>();

  for (const items of byCategory.values()) {
    const sorted = [...items].sort((a, b) => a.score - b.score);
    const n = sorted.length;
    for (let i = 0; i < n; i++) {
      normalised.set(sorted[i]!.id, n === 1 ? 0.5 : i / (n - 1));
    }
  }

  return normalised;
}

/** Assign class from 0-1 normalised score. */
function assignClass(score: number): BestsellerClass {
  if (score >= CLASS_THRESHOLDS.bestseller) return "bestseller";
  if (score >= CLASS_THRESHOLDS.high) return "high";
  if (score >= CLASS_THRESHOLDS.medium) return "medium";
  return "low";
}

/**
 * Compute stock health score 0-1 from inventory quantities.
 * Used as one component of the bestseller score.
 */
export function computeStockHealth(
  stockOnline: number | null,
  stockTotal: number | null,
): number {
  const stock = stockOnline ?? stockTotal ?? 0;
  if (stock <= 0) return 0;
  if (stock >= 10) return 1;
  return stock / 10; // Linear 0-10 units
}
