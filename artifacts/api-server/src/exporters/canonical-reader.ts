/**
 * Canonical Reader — loads all eligible canonical products from the DB.
 *
 * Queries the DB in bulk (one pass per entity type), then calls buildCanonical()
 * for each valid (variant × market) combination. Feed items are persisted in
 * feed_items for incremental change detection.
 */

import {
  db,
  productsTable,
  variantsTable,
  marketVariantsTable,
  productTranslationsTable,
  imagesTable,
  inventoryLevelsTable,
  recommendationsTable,
  feedItemsTable,
} from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import type { CanonicalProduct } from "../canonical/types";
import type { CanonicalChannel } from "../canonical/builder";
import { buildCanonical } from "../canonical/builder";
import type { AppConfig } from "../config/schemas";
import type {
  ProductRow,
  VariantRow,
  MarketVariantRow,
  TranslationRow,
  ImageRow,
  InventoryRow,
  RecommendationRow,
} from "../canonical/types";
import { computeChecksum } from "../shopify/checksums";

/**
 * Compute a stable checksum for a canonical product.
 *
 * Includes all business-significant fields that should trigger re-export
 * when changed (price, availability, images, title, labels, etc.).
 * Excludes volatile timestamps (`generatedAt`) so two identical canonicals
 * built at different times get the same checksum.
 */
function canonicalChecksum(c: CanonicalProduct): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { generatedAt: _omit, ...stable } = c;
  return computeChecksum(stable);
}
import { logger as rootLogger } from "../lib/logger";

const logger = rootLogger.child({ module: "canonical-reader" });

export interface ReadOptions {
  /** Markets to include. Undefined = all configured markets. */
  markets?: string[];
  channel: CanonicalChannel;
  /** If true, persist each canonical to feed_items table. */
  persistFeedItems?: boolean;
}

export interface ReadResult {
  canonicals: CanonicalProduct[];
  eligible: number;
  ineligible: number;
  excluded: number;
}

// ── Main reader ────────────────────────────────────────────────────────────────

/**
 * Load ALL canonical products from the DB for the given channel and markets.
 *
 * Loads data in bulk (no N+1 queries) then builds canonicals in memory.
 */
export async function readAllCanonicals(
  config: AppConfig,
  options: ReadOptions,
): Promise<ReadResult> {
  const { channel, persistFeedItems = false } = options;

  const targetMarkets = options.markets ?? Object.keys(config.markets.markets);
  const sourceMarkets = [...new Set(targetMarkets.map(
    (marketCode) => config.markets.markets[marketCode]?.pricing_market ?? marketCode,
  ))];
  logger.info({ markets: targetMarkets, channel }, "Loading canonical products");

  // ── 1. Load active products ──────────────────────────────────────────────
  const products = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.status, "active"));

  if (products.length === 0) {
    logger.info("No active products found");
    return { canonicals: [], eligible: 0, ineligible: 0, excluded: 0 };
  }

  const productIds = products.map((p) => p.id);
  logger.info({ count: products.length }, "Active products loaded");

  // ── 2. Load variants ────────────────────────────────────────────────────
  const variants = await db
    .select()
    .from(variantsTable)
    .where(inArray(variantsTable.productId, productIds));

  const variantIds = variants.map((v) => v.id);

  // ── 3. Load market variants ─────────────────────────────────────────────
  const marketVariants = variantIds.length > 0
    ? await db
        .select()
        .from(marketVariantsTable)
        .where(
          and(
            inArray(marketVariantsTable.variantId, variantIds),
            inArray(marketVariantsTable.marketCode, sourceMarkets),
          ),
        )
    : [];

  // ── 4. Load translations ────────────────────────────────────────────────
  const translations = await db
    .select()
    .from(productTranslationsTable)
    .where(inArray(productTranslationsTable.productId, productIds));

  // ── 5. Load images ──────────────────────────────────────────────────────
  const images = await db
    .select()
    .from(imagesTable)
    .where(inArray(imagesTable.productId, productIds));

  // ── 6. Load inventory levels ─────────────────────────────────────────────
  const inventory = variantIds.length > 0
    ? await db
        .select()
        .from(inventoryLevelsTable)
        .where(inArray(inventoryLevelsTable.variantId, variantIds))
    : [];

  // ── 7. Load recommendations ─────────────────────────────────────────────
  const recommendations = productIds.length > 0
    ? await db
        .select()
        .from(recommendationsTable)
        .where(inArray(recommendationsTable.productId, productIds))
    : [];

  // ── 8. Build lookup maps ────────────────────────────────────────────────
  const variantsByProduct = new Map<string, typeof variants>();
  for (const v of variants) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }

  const marketVariantsByVariant = new Map<string, typeof marketVariants>();
  for (const mv of marketVariants) {
    const list = marketVariantsByVariant.get(mv.variantId) ?? [];
    list.push(mv);
    marketVariantsByVariant.set(mv.variantId, list);
  }

  const translationsByProduct = new Map<string, typeof translations>();
  for (const t of translations) {
    const list = translationsByProduct.get(t.productId) ?? [];
    list.push(t);
    translationsByProduct.set(t.productId, list);
  }

  const imagesByProduct = new Map<string, typeof images>();
  for (const img of images) {
    const list = imagesByProduct.get(img.productId) ?? [];
    list.push(img);
    imagesByProduct.set(img.productId, list);
  }

  const inventoryByVariant = new Map<string, typeof inventory>();
  for (const inv of inventory) {
    const list = inventoryByVariant.get(inv.variantId) ?? [];
    list.push(inv);
    inventoryByVariant.set(inv.variantId, list);
  }

  // Recommendations: productId+marketCode → row
  const recKey = (productId: string, marketCode: string) => `${productId}:${marketCode}`;
  const recByProductMarket = new Map<string, (typeof recommendations)[0]>();
  for (const r of recommendations) {
    recByProductMarket.set(recKey(r.productId, r.marketCode), r);
  }

  // ── 9. Build canonicals ─────────────────────────────────────────────────
  const canonicals: CanonicalProduct[] = [];
  let ineligible = 0;
  let excluded = 0;

  for (const product of products) {
    const productVariants = variantsByProduct.get(product.id) ?? [];

    for (const variant of productVariants) {
      const variantMVs = marketVariantsByVariant.get(variant.id) ?? [];
      if (variantMVs.length === 0) continue;

      for (const marketCode of targetMarkets) {
        const market = config.markets.markets[marketCode];
        if (!market) continue;
        const sourceMarketCode = market.pricing_market ?? marketCode;
        const mv = variantMVs.find((candidate) => candidate.marketCode === sourceMarketCode);
        if (!mv) continue;
        if (!mv.isEligible) {
          ineligible++;
          continue;
        }

        const rec = recByProductMarket.get(recKey(product.id, sourceMarketCode)) ?? null;

        const canonical = buildCanonical(
          {
            product: product as unknown as ProductRow,
            variant: variant as unknown as VariantRow,
            marketVariants: variantMVs as unknown as MarketVariantRow[],
            translations: (translationsByProduct.get(product.id) ?? []) as unknown as TranslationRow[],
            images: (imagesByProduct.get(product.id) ?? []) as unknown as ImageRow[],
            inventoryLevels: (inventoryByVariant.get(variant.id) ?? []) as unknown as InventoryRow[],
            recommendations: rec as unknown as RecommendationRow | null,
            normalizedBestsellerScore: null,
            config,
          },
          marketCode,
          channel,
        );

        if (!canonical) {
          excluded++;
          continue;
        }

        canonicals.push(canonical);

        // Persist feed item if requested
        if (persistFeedItems) {
          const checksum = canonicalChecksum(canonical);
          await db
            .insert(feedItemsTable)
            .values({
              variantId: variant.id,
              marketCode,
              language: canonical.language,
              channel,
              canonicalJson: canonical as unknown as Record<string, unknown>,
              isEligible: canonical.exclusionReasons.length === 0,
              exclusionReason: canonical.exclusionReasons[0] ?? null,
              dataQualityScore: String(canonical.dataQualityScore),
              checksum,
            })
            .onConflictDoUpdate({
              target: [
                feedItemsTable.variantId,
                feedItemsTable.marketCode,
                feedItemsTable.language,
                feedItemsTable.channel,
              ],
              set: {
                canonicalJson: canonical as unknown as Record<string, unknown>,
                isEligible: canonical.exclusionReasons.length === 0,
                exclusionReason: canonical.exclusionReasons[0] ?? null,
                dataQualityScore: String(canonical.dataQualityScore),
                checksum,
                updatedAt: new Date(),
              },
            });
        }
      }
    }
  }

  logger.info(
    { eligible: canonicals.length, ineligible, excluded },
    "Canonicals built",
  );

  return { canonicals, eligible: canonicals.length, ineligible, excluded };
}

// ── Streaming reader ──────────────────────────────────────────────────────────

export type CanonicalCallback = (canonical: CanonicalProduct) => Promise<void> | void;

export interface StreamResult {
  eligible: number;
  ineligible: number;
  excluded: number;
}

const UPSERT_BATCH_SIZE = 100;

/**
 * Memory-efficient alternative to readAllCanonicals.
 *
 * Canonicals are never accumulated in a large array — each is passed to
 * `onCanonical` immediately and can be GC'd once the callback returns.
 * Feed-items upserts are batched (UPSERT_BATCH_SIZE at a time) instead of
 * one-per-canonical, giving a 100× reduction in DB round-trips.
 *
 * The callback is called for every ELIGIBLE canonical (exclusionReasons empty).
 * Ineligible canonicals (non-zero exclusionReasons) are persisted to
 * feed_items (for dashboard diagnostics) but NOT passed to the callback.
 */
export async function processAllCanonicals(
  config: AppConfig,
  options: ReadOptions,
  onCanonical: CanonicalCallback,
): Promise<StreamResult> {
  const { channel, persistFeedItems = false } = options;

  const targetMarkets = options.markets ?? Object.keys(config.markets.markets);
  const sourceMarkets = [...new Set(targetMarkets.map(
    (marketCode) => config.markets.markets[marketCode]?.pricing_market ?? marketCode,
  ))];
  logger.info({ markets: targetMarkets, channel }, "Streaming canonical products");

  // ── Bulk data loading (same as readAllCanonicals) ─────────────────────────
  const products = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.status, "active"));

  if (products.length === 0) {
    logger.info("No active products found");
    return { eligible: 0, ineligible: 0, excluded: 0 };
  }

  const productIds = products.map((p) => p.id);
  logger.info({ count: products.length }, "Active products loaded");

  const variants = await db
    .select()
    .from(variantsTable)
    .where(inArray(variantsTable.productId, productIds));

  const variantIds = variants.map((v) => v.id);

  const marketVariants = variantIds.length > 0
    ? await db
        .select()
        .from(marketVariantsTable)
        .where(
          and(
            inArray(marketVariantsTable.variantId, variantIds),
            inArray(marketVariantsTable.marketCode, sourceMarkets),
          ),
        )
    : [];

  const translations = await db
    .select()
    .from(productTranslationsTable)
    .where(inArray(productTranslationsTable.productId, productIds));

  const images = await db
    .select()
    .from(imagesTable)
    .where(inArray(imagesTable.productId, productIds));

  const inventory = variantIds.length > 0
    ? await db
        .select()
        .from(inventoryLevelsTable)
        .where(inArray(inventoryLevelsTable.variantId, variantIds))
    : [];

  const recommendations = productIds.length > 0
    ? await db
        .select()
        .from(recommendationsTable)
        .where(inArray(recommendationsTable.productId, productIds))
    : [];

  // ── Build lookup maps ─────────────────────────────────────────────────────
  const variantsByProduct = new Map<string, typeof variants>();
  for (const v of variants) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }

  const marketVariantsByVariant = new Map<string, typeof marketVariants>();
  for (const mv of marketVariants) {
    const list = marketVariantsByVariant.get(mv.variantId) ?? [];
    list.push(mv);
    marketVariantsByVariant.set(mv.variantId, list);
  }

  const translationsByProduct = new Map<string, typeof translations>();
  for (const t of translations) {
    const list = translationsByProduct.get(t.productId) ?? [];
    list.push(t);
    translationsByProduct.set(t.productId, list);
  }

  const imagesByProduct = new Map<string, typeof images>();
  for (const img of images) {
    const list = imagesByProduct.get(img.productId) ?? [];
    list.push(img);
    imagesByProduct.set(img.productId, list);
  }

  const inventoryByVariant = new Map<string, typeof inventory>();
  for (const inv of inventory) {
    const list = inventoryByVariant.get(inv.variantId) ?? [];
    list.push(inv);
    inventoryByVariant.set(inv.variantId, list);
  }

  const recKey = (productId: string, marketCode: string) => `${productId}:${marketCode}`;
  const recByProductMarket = new Map<string, (typeof recommendations)[0]>();
  for (const r of recommendations) {
    recByProductMarket.set(recKey(r.productId, r.marketCode), r);
  }

  // ── Process canonicals one at a time ──────────────────────────────────────
  let eligible = 0;
  let ineligible = 0;
  let excluded = 0;

  type UpsertRow = (typeof feedItemsTable)["$inferInsert"];
  const upsertBatch: UpsertRow[] = [];

  async function flushUpsertBatch() {
    if (upsertBatch.length === 0) return;
    const batch = upsertBatch.splice(0);
    await db
      .insert(feedItemsTable)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          feedItemsTable.variantId,
          feedItemsTable.marketCode,
          feedItemsTable.language,
          feedItemsTable.channel,
        ],
        set: {
          canonicalJson: sql`excluded.canonical_json`,
          isEligible: sql`excluded.is_eligible`,
          exclusionReason: sql`excluded.exclusion_reason`,
          dataQualityScore: sql`excluded.data_quality_score`,
          checksum: sql`excluded.checksum`,
          updatedAt: new Date(),
        },
      });
  }

  for (const product of products) {
    const productVariants = variantsByProduct.get(product.id) ?? [];

    for (const variant of productVariants) {
      const variantMVs = marketVariantsByVariant.get(variant.id) ?? [];
      if (variantMVs.length === 0) continue;

      for (const marketCode of targetMarkets) {
        const market = config.markets.markets[marketCode];
        if (!market) continue;
        const sourceMarketCode = market.pricing_market ?? marketCode;
        const mv = variantMVs.find((candidate) => candidate.marketCode === sourceMarketCode);
        if (!mv) continue;
        if (!mv.isEligible) {
          ineligible++;
          continue;
        }

        const rec = recByProductMarket.get(recKey(product.id, sourceMarketCode)) ?? null;

        const canonical = buildCanonical(
          {
            product: product as unknown as ProductRow,
            variant: variant as unknown as VariantRow,
            marketVariants: variantMVs as unknown as MarketVariantRow[],
            translations: (translationsByProduct.get(product.id) ?? []) as unknown as TranslationRow[],
            images: (imagesByProduct.get(product.id) ?? []) as unknown as ImageRow[],
            inventoryLevels: (inventoryByVariant.get(variant.id) ?? []) as unknown as InventoryRow[],
            recommendations: rec as unknown as RecommendationRow | null,
            normalizedBestsellerScore: null,
            config,
          },
          marketCode,
          channel,
        );

        if (!canonical) {
          excluded++;
          continue;
        }

        if (canonical.exclusionReasons.length === 0) {
          eligible++;
          await onCanonical(canonical);
        }

        if (persistFeedItems) {
          const checksum = canonicalChecksum(canonical);
          upsertBatch.push({
            variantId: variant.id,
            marketCode,
            language: canonical.language,
            channel,
            canonicalJson: canonical as unknown as Record<string, unknown>,
            isEligible: canonical.exclusionReasons.length === 0,
            exclusionReason: canonical.exclusionReasons[0] ?? null,
            dataQualityScore: String(canonical.dataQualityScore),
            checksum,
          });
          if (upsertBatch.length >= UPSERT_BATCH_SIZE) {
            await flushUpsertBatch();
          }
        }
      }
    }
  }

  if (persistFeedItems) {
    await flushUpsertBatch();
  }

  logger.info({ eligible, ineligible, excluded }, "Canonical stream complete");
  return { eligible, ineligible, excluded };
}
