/**
 * Category mapping pipeline — spec section 27.
 *
 * Shared between the runtime canonical builder and the offline backfill so
 * canonicalCategory is always derived by the same logic.
 *
 * Pipeline (priority order):
 * 1. Explicit mapping via product_type in categories.yaml
 * 2. Collection-based mapping
 * 3. Product type fuzzy match
 * 4. Fallback category (Furniture)
 * 5. Diagnostic (no match)
 *
 * Metafield overrides (google_category / meta_category) are applied PER CHANNEL
 * on top of the normal pipeline result. A Google override never clears the Meta
 * channel, and vice versa. canonicalCategory always comes from the pipeline.
 */

export interface CategoryMapping {
  shopify_type: string;
  canonical: string;
  google_category_id: string;
  google_category_label: string;
  meta_category: string;
  indoor_outdoor?: "indoor" | "outdoor" | "both";
}

export interface CategoriesConfig {
  fallback_google_category_id: string;
  fallback_google_category_label: string;
  fallback_meta_category: string;
  mappings: CategoryMapping[];
  collection_mappings?: unknown[];
}

export interface CategoryResult {
  canonicalCategory: string | null;
  googleCategoryId: string | null;
  googleCategoryLabel: string | null;
  metaCategory: string | null;
  indoorOutdoor: "indoor" | "outdoor" | "both" | null;
  mappingSource: "explicit" | "collection" | "fuzzy" | "fallback" | "none";
  diagnostic: string | null;
}

/**
 * Map a product's Shopify productType + collections to canonical categories.
 *
 * Metafield overrides are applied per channel — a Google override only replaces
 * googleCategoryId/Label; the Meta channel keeps its pipeline value and vice
 * versa. canonicalCategory is always from the pipeline (never null due to an
 * override).
 *
 * @param productType          - Shopify product_type field
 * @param collections          - array of collection titles/handles
 * @param config               - categories config (categories.yaml)
 * @param metafieldGoogleCategory - per-product Google category override
 * @param metafieldMetaCategory   - per-product Meta category override
 */
export function mapCategory(
  productType: string | null | undefined,
  collections: string[],
  config: CategoriesConfig,
  metafieldGoogleCategory?: string | null,
  metafieldMetaCategory?: string | null,
): CategoryResult {
  // ── Run normal pipeline first ──────────────────────────────────────────────
  const base = runPipeline(productType, collections, config);

  // ── Apply per-channel overrides on top of the pipeline result ────────────
  // A Google override replaces only the Google fields; Meta keeps its pipeline
  // value. A Meta override replaces only Meta; Google keeps its pipeline value.
  // canonicalCategory always comes from the pipeline.
  const hasOverride = !!(metafieldGoogleCategory || metafieldMetaCategory);

  return {
    canonicalCategory: base.canonicalCategory,
    googleCategoryId: metafieldGoogleCategory ?? base.googleCategoryId,
    // When Google is overridden by a free-form ID, clear the label (it's unknown)
    googleCategoryLabel: metafieldGoogleCategory ? null : base.googleCategoryLabel,
    metaCategory: metafieldMetaCategory ?? base.metaCategory,
    indoorOutdoor: base.indoorOutdoor,
    mappingSource: hasOverride ? "explicit" : base.mappingSource,
    diagnostic: base.diagnostic,
  };
}

// ── Internal pipeline ──────────────────────────────────────────────────────────

function runPipeline(
  productType: string | null | undefined,
  collections: string[],
  config: CategoriesConfig,
): CategoryResult {
  // Priority 1: explicit product_type mapping
  if (productType) {
    const match = findExplicitMapping(productType, config.mappings);
    if (match) {
      return {
        canonicalCategory: match.canonical,
        googleCategoryId: match.google_category_id,
        googleCategoryLabel: match.google_category_label,
        metaCategory: match.meta_category,
        indoorOutdoor: match.indoor_outdoor ?? null,
        mappingSource: "explicit",
        diagnostic: null,
      };
    }
  }

  // Priority 2: collection-based mapping
  for (const collection of collections) {
    const match = findExplicitMapping(collection, config.mappings);
    if (match) {
      return {
        canonicalCategory: match.canonical,
        googleCategoryId: match.google_category_id,
        googleCategoryLabel: match.google_category_label,
        metaCategory: match.meta_category,
        indoorOutdoor: match.indoor_outdoor ?? null,
        mappingSource: "collection",
        diagnostic: null,
      };
    }
  }

  // Priority 3: fuzzy product_type match (case-insensitive partial)
  if (productType) {
    const fuzzy = findFuzzyMapping(productType, config.mappings);
    if (fuzzy) {
      return {
        canonicalCategory: fuzzy.canonical,
        googleCategoryId: fuzzy.google_category_id,
        googleCategoryLabel: fuzzy.google_category_label,
        metaCategory: fuzzy.meta_category,
        indoorOutdoor: fuzzy.indoor_outdoor ?? null,
        mappingSource: "fuzzy",
        diagnostic: `Fuzzy match: "${productType}" → "${fuzzy.canonical}"`,
      };
    }
  }

  // Priority 4: fallback category
  return {
    canonicalCategory: null,
    googleCategoryId: config.fallback_google_category_id,
    googleCategoryLabel: config.fallback_google_category_label,
    metaCategory: config.fallback_meta_category,
    indoorOutdoor: null,
    mappingSource: "fallback",
    diagnostic: productType
      ? `No mapping for product_type="${productType}"; using fallback Furniture`
      : "No product_type; using fallback Furniture",
  };
}

/** Case-insensitive exact match on shopify_type field. */
function findExplicitMapping(
  input: string,
  mappings: CategoryMapping[],
): CategoryMapping | null {
  const normalized = input.toLowerCase().trim();
  return mappings.find((m) => m.shopify_type.toLowerCase().trim() === normalized) ?? null;
}

/** Partial/substring match for fuzzy fallback. */
function findFuzzyMapping(
  input: string,
  mappings: CategoryMapping[],
): CategoryMapping | null {
  const normalized = input.toLowerCase().trim();

  // Try: input contains the mapping key, or mapping key contains input
  for (const mapping of mappings) {
    const key = mapping.shopify_type.toLowerCase().trim();
    if (normalized.includes(key) || key.includes(normalized)) {
      return mapping;
    }
  }

  // Try individual word match
  const inputWords = normalized.split(/\s+/);
  for (const mapping of mappings) {
    const keyWords = mapping.shopify_type.toLowerCase().split(/\s+/);
    const overlap = inputWords.filter((w) => keyWords.includes(w));
    if (overlap.length > 0 && overlap.length >= Math.min(inputWords.length, keyWords.length)) {
      return mapping;
    }
  }

  return null;
}
