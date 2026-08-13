/**
 * Recommendation engine — spec sections 24, 25.
 *
 * Pure scoring functions live in @workspace/rec-engine so the offline backfill
 * script can import the identical implementation without coupling to the API
 * server. This module re-exports them under the legacy RecommendationProduct
 * alias and adds the ComplementaryConfig import shim for existing callers.
 */

import type { ComplementaryConfig } from "../config/schemas";
import {
  scoreRelatedProducts as _scoreRelatedProducts,
  findComplementaryProducts as _findComplementaryProducts,
  type RecProduct,
  type ScoredCandidate,
  type ComplementaryConfig as RecComplementaryConfig,
} from "@workspace/rec-engine";

// Re-export the shared types under the names existing callers use
export type RecommendationProduct = RecProduct;
export type { ScoredCandidate };

/**
 * Score related product candidates against the source product.
 *
 * Delegates to @workspace/rec-engine which is the single source of truth.
 * Both this runtime path and the offline backfill use the same code.
 */
export function scoreRelatedProducts(
  source: RecommendationProduct,
  candidates: RecommendationProduct[],
  priceTolerance = 0.20,
  maxPriceTolerance = 0.40,
  topN = 8,
): ScoredCandidate[] {
  return _scoreRelatedProducts(source, candidates, priceTolerance, maxPriceTolerance, topN);
}

/**
 * Find complementary product IDs from config mapping.
 *
 * ComplementaryConfig from the API config/schemas is structurally compatible
 * with RecComplementaryConfig — both have `complementary: Record<string, string[]>`.
 */
export function findComplementaryProducts(
  sourceCanonicalCategory: string | null,
  allProducts: RecommendationProduct[],
  config: ComplementaryConfig,
  manualRecommendations: string[] = [],
  topN = 8,
): string[] {
  return _findComplementaryProducts(
    sourceCanonicalCategory,
    allProducts,
    config as RecComplementaryConfig,
    manualRecommendations,
    topN,
  );
}
