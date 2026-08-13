/**
 * Recommendations sync job.
 *
 * Recalculates recommendation scores nightly for all markets.
 * Processes all active products and upserts the recommendations table.
 *
 * Uses the same scoring logic as the offline backfill script
 * (@workspace/rec-engine) — results are identical to the backfill for
 * the same DB state.
 *
 * Spec references: §24 (scoring algorithm), §25 (complementary products),
 * §60 (observability).
 */

import {
  db,
  productsTable,
  variantsTable,
  marketVariantsTable,
  recommendationsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  scoreRelatedProducts,
  findComplementaryProducts,
  mapCategory,
  type RecProduct,
  type ComplementaryConfig,
  type RecCategoriesConfig,
} from "@workspace/rec-engine";
import { loadConfig } from "../config/loader";
import { SyncRunTracker } from "../shopify/sync-run-tracker";
import { logger as rootLogger } from "../lib/logger";

const logger = rootLogger.child({ module: "sync-recommendations" });

// ── Config loading ────────────────────────────────────────────────────────────

interface RecsConfig {
  categoriesConfig: RecCategoriesConfig;
  complementaryConfig: ComplementaryConfig;
  topN: number;
  priceTolerancePct: number;
  priceToleranceMaxPct: number;
  marketCodes: string[];
}

function loadRecsConfig(): RecsConfig {
  // Use the established config loader — it resolves the config directory via
  // process.cwd() (set to the api-server package dir in both dev and prod).
  // This avoids brittle import.meta.url-relative paths that break after bundling.
  const config = loadConfig();

  return {
    categoriesConfig: config.categories,
    complementaryConfig: config.complementary,
    topN: config.feedPolicy.recommendations?.top_n ?? 8,
    priceTolerancePct: (config.feedPolicy.recommendations?.price_tolerance_pct ?? 20) / 100,
    priceToleranceMaxPct: (config.feedPolicy.recommendations?.price_tolerance_max_pct ?? 40) / 100,
    // config.markets is MarketsConfig: { markets: Record<string,MarketConfig>, language_masters: ... }
    // Use the nested .markets record to get the actual market codes (e.g. BE_FR, FR, DE, ...)
    marketCodes: Object.keys(config.markets.markets),
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run the full recommendations recalculation for all markets.
 * Returns the sync run ID.
 */
export async function runRecommendationsSync(): Promise<string> {
  const tracker = new SyncRunTracker();
  const runId = await tracker.start("recommendations");

  logger.info({ runId }, "Starting recommendations sync");

  try {
    const cfg = loadRecsConfig();

    // ── Load active products ────────────────────────────────────────────────
    const products = await db
      .select({
        id: productsTable.id,
        productType: productsTable.productType,
        vendor: productsTable.vendor,
      })
      .from(productsTable)
      .where(eq(productsTable.status, "active"));

    if (products.length === 0) {
      logger.warn({ runId }, "No active products found — skipping recommendations sync");
      await tracker.complete();
      return runId;
    }

    tracker.bumpRead(products.length);
    logger.info({ runId, count: products.length }, "Active products loaded");

    // ── Load variants with metafields ──────────────────────────────────────
    const variants = await db
      .select({
        id: variantsTable.id,
        productId: variantsTable.productId,
        metafieldMaterial: variantsTable.metafieldMaterial,
        metafieldStyle: variantsTable.metafieldStyle,
        metafieldDiscontinued: variantsTable.metafieldDiscontinued,
      })
      .from(variantsTable);

    // One representative variant per product for metafields
    const variantByProduct = new Map<string, typeof variants[0]>();
    for (const v of variants) {
      if (!variantByProduct.has(v.productId)) variantByProduct.set(v.productId, v);
    }

    // variantId → productId
    const variantProductMap = new Map<string, string>();
    for (const v of variants) variantProductMap.set(v.id, v.productId);

    // ── Process each market ────────────────────────────────────────────────
    let totalWritten = 0;

    for (const marketCode of cfg.marketCodes) {
      // Load eligible market variants for this market
      const marketVariants = await db
        .select({
          variantId: marketVariantsTable.variantId,
          priceAmount: marketVariantsTable.priceAmount,
          availability: marketVariantsTable.availability,
        })
        .from(marketVariantsTable)
        .where(
          sql`${marketVariantsTable.marketCode} = ${marketCode}
              AND ${marketVariantsTable.isEligible} = true`,
        );

      // Build productId → first eligible positive-priced market variant
      const eligibleMvByProductId = new Map<string, typeof marketVariants[0]>();
      for (const mv of marketVariants) {
        const price = parseFloat(mv.priceAmount ?? "0");
        if (price <= 0) continue;
        const productId = variantProductMap.get(mv.variantId);
        if (!productId) continue;
        if (!eligibleMvByProductId.has(productId)) eligibleMvByProductId.set(productId, mv);
      }

      // Build RecProduct list — only products eligible in this market
      const recProducts: RecProduct[] = products
        .filter((p) => eligibleMvByProductId.has(p.id))
        .map((p) => {
          const variant = variantByProduct.get(p.id);
          const mv = eligibleMvByProductId.get(p.id)!;
          const catResult = mapCategory(p.productType ?? null, [], cfg.categoriesConfig);
          return {
            id: p.id,
            productType: p.productType ?? null,
            vendor: p.vendor ?? null,
            collections: [], // collections not in bulk sync; empty same as backfill
            style: variant?.metafieldStyle ?? [],
            material: variant?.metafieldMaterial ?? [],
            priceAmount: parseFloat(mv.priceAmount ?? "0"),
            availability: mv.availability,
            canonicalCategory: catResult?.canonicalCategory ?? null,
            isDiscontinued: variant?.metafieldDiscontinued === true,
          };
        });

      const recProductMap = new Map(recProducts.map((p) => [p.id, p]));

      logger.info({ marketCode, eligible: recProducts.length }, "Computing recommendations for market");

      // Compute and upsert in chunks of 50
      const CHUNK = 50;
      for (let i = 0; i < recProducts.length; i += CHUNK) {
        const chunk = recProducts.slice(i, i + CHUNK);

        const values = chunk.map((source) => {
          const candidates = recProducts.filter((p) => p.id !== source.id);

          const related = scoreRelatedProducts(
            source,
            candidates,
            cfg.priceTolerancePct,
            cfg.priceToleranceMaxPct,
            cfg.topN,
          ).map((r) => r.productId);

          const complementary = findComplementaryProducts(
            source.canonicalCategory,
            candidates,
            cfg.complementaryConfig,
            [],
            cfg.topN,
          );

          return {
            productId: source.id,
            marketCode,
            relatedProductIds: related,
            complementaryProductIds: complementary,
          };
        });

        await db
          .insert(recommendationsTable)
          .values(values)
          .onConflictDoUpdate({
            target: [recommendationsTable.productId, recommendationsTable.marketCode],
            set: {
              relatedProductIds: sql`excluded.related_product_ids`,
              complementaryProductIds: sql`excluded.complementary_product_ids`,
              updatedAt: sql`now()`,
            },
          });

        totalWritten += chunk.length;
        tracker.bumpChanged(chunk.length);
      }
    }

    logger.info({ runId, totalWritten }, "Recommendations sync complete");
    await tracker.complete();
  } catch (err) {
    logger.error({ err, runId }, "Recommendations sync failed");
    await tracker.fail(err);
    throw err;
  }

  return runId;
}
