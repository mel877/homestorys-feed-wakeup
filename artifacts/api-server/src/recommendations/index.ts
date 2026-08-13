/**
 * Recommendation runner — loads products from DB, runs the engine,
 * and stores results in the recommendations table.
 *
 * Called nightly by the backfill script and by the sync orchestrator.
 */

import { db, productsTable, variantsTable, marketVariantsTable, recommendationsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";
import { loadConfig } from "../config";
import { scoreRelatedProducts, findComplementaryProducts } from "./engine";
import type { RecommendationProduct } from "./engine";
import { mapCategory } from "../categories/mapper";

const logger = rootLogger.child({ module: "recommendations" });

/**
 * Run and store recommendations for all products in a given market.
 */
export async function runRecommendationsForMarket(marketCode: string): Promise<void> {
  logger.info({ marketCode }, "Running recommendations for market");

  const config = loadConfig();

  // Load all active products with their canonical category
  const products = await db
    .select({
      id: productsTable.id,
      shopifyGid: productsTable.shopifyGid,
      productType: productsTable.productType,
      vendor: productsTable.vendor,
      tags: productsTable.tags,
      status: productsTable.status,
    })
    .from(productsTable)
    .where(eq(productsTable.status, "active"));

  // Load variants with metafields
  const variants = await db
    .select({
      id: variantsTable.id,
      productId: variantsTable.productId,
      metafieldStyle: variantsTable.metafieldStyle,
      metafieldMaterial: variantsTable.metafieldMaterial,
      metafieldDiscontinued: variantsTable.metafieldDiscontinued,
    })
    .from(variantsTable);

  // Load market variants for pricing — only eligible rows in this market
  const marketVariants = await db
    .select({
      variantId: marketVariantsTable.variantId,
      marketCode: marketVariantsTable.marketCode,
      priceAmount: marketVariantsTable.priceAmount,
      availability: marketVariantsTable.availability,
      isEligible: marketVariantsTable.isEligible,
    })
    .from(marketVariantsTable)
    .where(
      and(
        eq(marketVariantsTable.marketCode, marketCode),
        eq(marketVariantsTable.isEligible, true),
      ),
    );

  // Build recommendation product models

  // First variant per product — used for product-level metafields (style, material, discontinued)
  const variantByProduct = new Map<string, typeof variants[0]>();
  for (const v of variants) {
    if (!variantByProduct.has(v.productId)) {
      variantByProduct.set(v.productId, v);
    }
  }

  // variantId → productId (needed to resolve which product an eligible market variant belongs to)
  const variantProductMap = new Map<string, string>();
  for (const v of variants) {
    variantProductMap.set(v.id, v.productId);
  }

  // For each product: the first eligible (isEligible=true, price > 0) market variant.
  // We CANNOT use variantByProduct here because the "first variant" may be ineligible
  // while another variant of the same product IS eligible in this market.
  const eligibleMvByProductId = new Map<string, typeof marketVariants[0]>();
  for (const mv of marketVariants) {
    const price = parseFloat(mv.priceAmount ?? "0");
    if (price <= 0) continue;
    const productId = variantProductMap.get(mv.variantId);
    if (!productId) continue;
    if (!eligibleMvByProductId.has(productId)) {
      eligibleMvByProductId.set(productId, mv);
    }
  }

  // Map products to recommendation model — EXCLUDE products not eligible in this market
  const recProducts: RecommendationProduct[] = products
    .filter((p) => eligibleMvByProductId.has(p.id))
    .map((p) => {
      // Metafields from any representative variant (product-level data)
      const variant = variantByProduct.get(p.id);
      // Price/availability from the eligible market variant (not necessarily the same one)
      const mv = eligibleMvByProductId.get(p.id);

      const categoryResult = mapCategory(p.productType, [], config.categories);

      return {
        id: p.id,
        productType: p.productType,
        vendor: p.vendor,
        collections: [],
        style: variant?.metafieldStyle ?? [],
        material: variant?.metafieldMaterial ?? [],
        priceAmount: mv?.priceAmount ? parseFloat(mv.priceAmount) : null,
        availability: mv?.availability ?? "out_of_stock",
        canonicalCategory: categoryResult.canonicalCategory,
        isDiscontinued: variant?.metafieldDiscontinued ?? false,
      };
    });

  logger.info(
    { total: products.length, eligible: recProducts.length, marketCode },
    "Loaded products for recommendation scoring (eligible in market only)",
  );

  // Score recommendations for each product
  let upserted = 0;
  const BATCH_SIZE = 50;
  const policyConfig = config.feedPolicy;

  for (let i = 0; i < recProducts.length; i += BATCH_SIZE) {
    const batch = recProducts.slice(i, i + BATCH_SIZE);

    await db.transaction(async (tx) => {
      for (const source of batch) {
        const candidates = recProducts.filter((p) => p.id !== source.id);

        const related = scoreRelatedProducts(
          source,
          candidates,
          policyConfig.recommendations.price_tolerance_pct / 100,
          policyConfig.recommendations.price_tolerance_max_pct / 100,
          policyConfig.recommendations.top_n,
        );

        const complementary = findComplementaryProducts(
          source.canonicalCategory,
          candidates,
          config.complementary,
          [],
          policyConfig.recommendations.top_n,
        );

        await tx
          .insert(recommendationsTable)
          .values({
            productId: source.id,
            marketCode,
            relatedProductIds: related.map((r) => r.productId),
            complementaryProductIds: complementary,
          })
          .onConflictDoUpdate({
            target: [recommendationsTable.productId, recommendationsTable.marketCode],
            set: {
              relatedProductIds: related.map((r) => r.productId),
              complementaryProductIds: complementary,
              updatedAt: new Date(),
              generatedAt: new Date(),
            },
          });

        upserted++;
      }
    });

    logger.debug({ processed: i + batch.length, total: recProducts.length }, "Recommendations progress");
  }

  logger.info({ upserted, marketCode }, "Recommendations run complete");
}

/**
 * Run recommendations for all configured markets.
 */
export async function runAllRecommendations(): Promise<void> {
  const config = loadConfig();
  const markets = Object.keys(config.markets.markets);

  for (const marketCode of markets) {
    await runRecommendationsForMarket(marketCode);
  }
}
