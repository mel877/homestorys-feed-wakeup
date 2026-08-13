/**
 * Category mapping pipeline — spec section 27.
 *
 * The pure mapping logic lives in @workspace/rec-engine/src/category-mapper.ts
 * so the offline backfill script uses identical code. This module re-exports
 * from there and adapts the CategoriesConfig type alias for existing callers.
 */

import {
  mapCategory as _mapCategory,
  type CategoryResult,
  type RecCategoriesConfig,
} from "@workspace/rec-engine";
import type { CategoriesConfig } from "../config/schemas";

// Re-export so callers that import from this module keep working
export type { CategoryResult };

/**
 * Map a product's Shopify productType + collections to canonical categories.
 *
 * Thin shim: CategoriesConfig (api-server schema) is structurally compatible
 * with RecCategoriesConfig (rec-engine) — both have the same fields from YAML.
 *
 * Per-channel override fix: metafield overrides are applied independently per
 * channel on top of the normal pipeline result. A Google override never clears
 * the Meta channel and vice versa. canonicalCategory always comes from the
 * pipeline (never null due to an override).
 */
export function mapCategory(
  productType: string | null | undefined,
  collections: string[],
  config: CategoriesConfig,
  metafieldGoogleCategory?: string | null,
  metafieldMetaCategory?: string | null,
): CategoryResult {
  return _mapCategory(
    productType,
    collections,
    config as RecCategoriesConfig,
    metafieldGoogleCategory,
    metafieldMetaCategory,
  );
}
