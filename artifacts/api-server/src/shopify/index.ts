/**
 * Shopify sync orchestration.
 *
 * Provides top-level sync functions called by the internal API and webhook worker.
 * Each function creates a SyncRun record and chains the appropriate sub-syncs.
 *
 * Required scopes:
 *   read_products, read_inventory, read_markets, read_translations,
 *   read_locales, read_publications, read_price_rules
 */

import { logger as rootLogger } from "../lib/logger";
import { getShopifyClient } from "./client";
import { SyncRunTracker } from "./sync-run-tracker";
import { syncProducts, syncSingleProduct } from "./sync-products";
import { syncMarketPricing } from "./sync-markets";
import { syncInventory, syncSingleInventoryItem } from "./sync-inventory";
import { syncTranslations, syncProductTranslations } from "./sync-translations";
import { classifyStoredImages, reclassifyProductImages } from "../images/classify-stored";
import { db, productsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const logger = rootLogger.child({ module: "shopify-sync" });

// ── Required API scopes ───────────────────────────────────────────────────────

const REQUIRED_SCOPES = [
  "read_products",
  "read_inventory",
  "read_markets",
  "read_translations",
  "read_locales",
];

// ── Full sync ─────────────────────────────────────────────────────────────────

/**
 * Full catalog sync: products → market pricing → inventory → translations.
 * Creates a sync_run record and updates it as each phase completes.
 * Returns the sync run ID.
 */
export async function runFullSync(): Promise<string> {
  const client = getShopifyClient();
  const tracker = new SyncRunTracker();
  const runId = await tracker.start("full");

  logger.info({ runId }, "Starting full sync");

  try {
    // Validate scopes on first full sync
    await client.validateScopes(REQUIRED_SCOPES);

    // Phase 1: Products + variants + images
    logger.info({ runId }, "Phase 1: products");
    await syncProducts(client, tracker);

    // Phase 2: Market pricing
    logger.info({ runId }, "Phase 2: market pricing");
    await syncMarketPricing(client, tracker);

    // Phase 3: Inventory
    logger.info({ runId }, "Phase 3: inventory");
    await syncInventory(client, tracker);

    // Phase 4: Translations
    logger.info({ runId }, "Phase 4: translations");
    await syncTranslations(client, tracker);

    // Phase 5: Image classification — drain all unclassified images in pages
    // until none remain. The sync deletes/reinserts images, so all are unclassified.
    logger.info({ runId }, "Phase 5: image classification (draining all unclassified)");
    const classifyResult = await classifyStoredImages();
    logger.info({ runId, ...classifyResult }, "Image classification drain complete");

    await tracker.complete();
    logger.info({ runId }, "Full sync complete");
  } catch (err) {
    logger.error({ err, runId }, "Full sync failed");
    await tracker.fail(err);
    throw err;
  }

  return runId;
}

// ── Inventory-only sync ───────────────────────────────────────────────────────

export async function runInventorySync(): Promise<string> {
  const client = getShopifyClient();
  const tracker = new SyncRunTracker();
  const runId = await tracker.start("inventory");

  logger.info({ runId }, "Starting inventory sync");

  try {
    await syncInventory(client, tracker);
    await tracker.complete();
    logger.info({ runId }, "Inventory sync complete");
  } catch (err) {
    logger.error({ err, runId }, "Inventory sync failed");
    await tracker.fail(err);
    throw err;
  }

  return runId;
}

// ── Price-only sync ───────────────────────────────────────────────────────────

export async function runPriceSync(): Promise<string> {
  const client = getShopifyClient();
  const tracker = new SyncRunTracker();
  const runId = await tracker.start("prices");

  logger.info({ runId }, "Starting price sync");

  try {
    await syncMarketPricing(client, tracker);
    await tracker.complete();
    logger.info({ runId }, "Price sync complete");
  } catch (err) {
    logger.error({ err, runId }, "Price sync failed");
    await tracker.fail(err);
    throw err;
  }

  return runId;
}

// ── Targeted single-product sync ──────────────────────────────────────────────

/**
 * Sync a single product by its Shopify GID or numeric ID.
 * Used by the webhook worker for real-time delta updates.
 * Accepts either "gid://shopify/Product/123" or "123".
 */
export async function syncProduct(shopifyProductRef: string): Promise<string> {
  const productGid = shopifyProductRef.startsWith("gid://")
    ? shopifyProductRef
    : `gid://shopify/Product/${shopifyProductRef}`;

  const client = getShopifyClient();
  const tracker = new SyncRunTracker();
  const runId = await tracker.start("product", { productGid });

  logger.info({ runId, productGid }, "Starting single product sync");

  try {
    await syncSingleProduct(client, productGid, tracker);

    // Find the product DB ID for translation sync
    const [dbProduct] = await db
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(eq(productsTable.shopifyGid, productGid))
      .limit(1);

    if (dbProduct) {
      await syncProductTranslations(client, dbProduct.id, productGid);
      // Re-classify images for this product after sync
      await reclassifyProductImages(dbProduct.id);
    }

    await tracker.complete();
    logger.info({ runId, productGid }, "Single product sync complete");
  } catch (err) {
    logger.error({ err, runId, productGid }, "Single product sync failed");
    await tracker.fail(err);
    throw err;
  }

  return runId;
}

// ── Targeted inventory update ─────────────────────────────────────────────────

/**
 * Update inventory for a single inventory item.
 * Used by the webhook worker for inventory_levels/update events.
 * Accepts inventory item numeric ID or GID.
 */
export async function updateInventoryItem(shopifyInventoryItemRef: string): Promise<void> {
  const gid = shopifyInventoryItemRef.startsWith("gid://")
    ? shopifyInventoryItemRef
    : `gid://shopify/InventoryItem/${shopifyInventoryItemRef}`;

  const client = getShopifyClient();
  await syncSingleInventoryItem(client, gid);
  logger.debug({ gid }, "Inventory item updated via targeted sync");
}

// ── Sync status ───────────────────────────────────────────────────────────────

export { SyncRunTracker };
export { getShopifyClient };
