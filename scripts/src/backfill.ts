/**
 * Backfill script — compute product recommendations for all markets.
 *
 * Self-contained: imports ONLY from @workspace/db, @workspace/rec-engine,
 * drizzle-orm, yaml, and Node built-ins.
 *
 * ALGORITHM PARITY: By importing scoreRelatedProducts and findComplementaryProducts
 * from @workspace/rec-engine — the same package the runtime engine uses — this
 * script is guaranteed to produce identical results to runRecommendationsForMarket()
 * for the same DB state. There is no separate copy of the scoring logic.
 *
 * Algorithm summary:
 *   - Only `status = 'active'` products (draft/archived excluded)
 *   - Only products with an eligible (isEligible=true), positive-priced market
 *     variant in the target market are included as source AND candidate
 *   - Scoring: sameProductType +30, sameBrand +20, sameCollection +20,
 *     sameStyle +10, sameMaterial +10, similarPrice +10
 *   - Price tolerance: try policy.price_tolerance_pct%, then 30%, then max%;
 *     stop when ≥ min(4, top_n) results found
 *   - Secondary sort: prefer in_stock at equal scores (in all paths)
 *   - Complementary: config/complementary.yaml adjacency; ≤2 per category
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill
 *
 * Required env:
 *   DATABASE_URL
 * Optional:
 *   CONFIG_DIR   override config directory (default: <workspace-root>/config)
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

import {
  db,
  productsTable,
  variantsTable,
  marketVariantsTable,
  recommendationsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { scoreRelatedProducts, findComplementaryProducts, mapCategory } from "@workspace/rec-engine";
import type { RecProduct, ComplementaryConfig, RecCategoriesConfig } from "@workspace/rec-engine";

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR =
  process.env["CONFIG_DIR"] ?? resolve(__dir, "../../config");

// ── Logging ────────────────────────────────────────────────────────────────────

function log(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  console.log(data ? `[${ts}] ${msg} ${JSON.stringify(data)}` : `[${ts}] ${msg}`);
}

// ── Config loading ─────────────────────────────────────────────────────────────

interface FeedPolicyYaml {
  recommendations?: {
    top_n?: number;
    price_tolerance_pct?: number;
    price_tolerance_max_pct?: number;
  };
}
interface MarketsYaml {
  markets: Record<string, unknown>;
}

function readYaml<T>(filename: string): T {
  return parseYaml(readFileSync(resolve(CONFIG_DIR, filename), "utf-8")) as T;
}

function loadConfig() {
  // Cast to RecCategoriesConfig — the YAML structure matches the shared type
  // (same fields the runtime api-server validates via CategoriesConfigSchema).
  const categoriesConfig = readYaml<RecCategoriesConfig>("categories.yaml");
  const complementary = readYaml<ComplementaryConfig>("complementary.yaml");
  const policy = readYaml<FeedPolicyYaml>("feed-policy.yaml");
  const markets = readYaml<MarketsYaml>("markets.yaml");

  return {
    categoriesConfig,
    complementaryConfig: complementary,
    topN: policy.recommendations?.top_n ?? 8,
    priceTolerancePct: (policy.recommendations?.price_tolerance_pct ?? 20) / 100,
    priceToleranceMaxPct: (policy.recommendations?.price_tolerance_max_pct ?? 40) / 100,
    marketCodes: Object.keys(markets.markets ?? {}),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("Backfill started");

  const cfg = loadConfig();
  log("Config loaded", {
    markets: cfg.marketCodes.length,
    categories: cfg.categoriesConfig.mappings?.length ?? 0,
    topN: cfg.topN,
    priceTolerance: `${cfg.priceTolerancePct * 100}%`,
    priceToleranceMax: `${cfg.priceToleranceMaxPct * 100}%`,
  });

  // ── Load ACTIVE products only (same filter as runRecommendationsForMarket) ──
  const products = await db
    .select({
      id: productsTable.id,
      productType: productsTable.productType,
      vendor: productsTable.vendor,
    })
    .from(productsTable)
    .where(eq(productsTable.status, "active"));

  if (products.length === 0) {
    log("No active products found — run a Shopify sync first.");
    return;
  }
  log("Active products loaded", { count: products.length });

  // ── Load variants with metafields ────────────────────────────────────────────
  const variants = await db
    .select({
      id: variantsTable.id,
      productId: variantsTable.productId,
      metafieldMaterial: variantsTable.metafieldMaterial,
      metafieldStyle: variantsTable.metafieldStyle,
      metafieldDiscontinued: variantsTable.metafieldDiscontinued,
    })
    .from(variantsTable);

  // One representative variant per product for metafields (same as index.ts)
  const variantByProduct = new Map<string, typeof variants[0]>();
  for (const v of variants) {
    if (!variantByProduct.has(v.productId)) variantByProduct.set(v.productId, v);
  }

  // variantId → productId (for eligible MV join, same as index.ts)
  const variantProductMap = new Map<string, string>();
  for (const v of variants) variantProductMap.set(v.id, v.productId);

  // ── Per market ────────────────────────────────────────────────────────────────
  let totalWritten = 0;

  for (const marketCode of cfg.marketCodes) {
    // Load only isEligible=true market variants (same filter as index.ts)
    const marketVariants = await db
      .select({
        variantId: marketVariantsTable.variantId,
        priceAmount: marketVariantsTable.priceAmount,
        availability: marketVariantsTable.availability,
      })
      .from(marketVariantsTable)
      .where(
        sql`${marketVariantsTable.marketCode} = ${marketCode} AND ${marketVariantsTable.isEligible} = true`,
      );

    // Build productId → first eligible positive-priced market variant (same as index.ts)
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
        const mv = eligibleMvByProductId.get(p.id);
        return {
          id: p.id,
          productType: p.productType,
          vendor: p.vendor,
          collections: [], // collections not in bulk sync; empty same as index.ts
          style: variant?.metafieldStyle ?? [],
          material: variant?.metafieldMaterial ?? [],
          priceAmount: mv?.priceAmount ? parseFloat(mv.priceAmount) : null,
          availability: mv?.availability ?? "out_of_stock",
          canonicalCategory: mapCategory(p.productType, [], cfg.categoriesConfig).canonicalCategory,
          isDiscontinued: variant?.metafieldDiscontinued ?? false,
        };
      });

    log("Market", { marketCode, eligible: recProducts.length });

    let written = 0;
    const BATCH_SIZE = 50;

    for (let i = 0; i < recProducts.length; i += BATCH_SIZE) {
      const batch = recProducts.slice(i, i + BATCH_SIZE);

      await db.transaction(async (tx) => {
        for (const source of batch) {
          const candidates = recProducts.filter((p) => p.id !== source.id);

          // scoreRelatedProducts and findComplementaryProducts are imported from
          // @workspace/rec-engine — the SAME code the runtime engine uses.
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

          await tx
            .insert(recommendationsTable)
            .values({
              productId: source.id,
              marketCode,
              relatedProductIds: related,
              complementaryProductIds: complementary,
              generatedAt: new Date(),
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [recommendationsTable.productId, recommendationsTable.marketCode],
              set: {
                relatedProductIds: sql`excluded.related_product_ids`,
                complementaryProductIds: sql`excluded.complementary_product_ids`,
                generatedAt: sql`excluded.generated_at`,
                updatedAt: sql`now()`,
              },
            });

          written++;
        }
      });

      log("Progress", { marketCode, processed: i + batch.length, total: recProducts.length });
    }

    totalWritten += written;
    log("Market complete", { marketCode, written });
  }

  log("Backfill complete", { totalWritten });
}

main().catch((err: unknown) => {
  console.error("[backfill] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
