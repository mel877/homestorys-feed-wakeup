/**
 * Inventory sync — fetches inventory levels per variant per location.
 *
 * Uses a Shopify Bulk Operation on `inventoryItems` which is the most
 * efficient way to fetch all inventory levels at once.
 *
 * After inventory levels are persisted, updates market_variants.availability
 * based on aggregated stock per market (initially: Eupen location only).
 */

import { db, variantsTable, inventoryLevelsTable, marketVariantsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";
import { loadConfig } from "../config";
import type { ShopifyClient } from "./client";
import { runBulkQuery } from "./bulk-ops";
import type { SyncRunTracker } from "./sync-run-tracker";
import type { BulkNode } from "./types";

const logger = rootLogger.child({ module: "sync-inventory" });

// ── GraphQL bulk query ────────────────────────────────────────────────────────

// Bulk operations use standard GraphQL connection syntax (edges/node).
// Shopify flattens the JSONL output with __parentId for child records.
// inventoryItem node → __parentId unset; inventoryLevel → __parentId = inventoryItem GID.
const BULK_INVENTORY_QUERY = `
{
  inventoryItems {
    edges {
      node {
        id
        sku
        variant {
          id
        }
        inventoryLevels {
          edges {
            node {
              quantities(names: ["available"]) {
                name
                quantity
              }
              location {
                id
                name
              }
            }
          }
        }
      }
    }
  }
}
`;

// Single-item targeted fetch (for webhook inventory_levels/update)
export const SINGLE_INVENTORY_QUERY = `
  query GetInventoryLevels($inventoryItemId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      id
      variant { id }
      inventoryLevels(first: 30) {
        edges {
          node {
            quantities(names: ["available"]) {
              name
              quantity
            }
            location { id name }
          }
        }
      }
    }
  }
`;

// ── Node type guards ──────────────────────────────────────────────────────────

interface InventoryItemNode extends BulkNode {
  sku: string | null;
  variant: { id: string } | null;
}

interface InventoryLevelNode extends BulkNode {
  __parentId: string;
  // In API 2025-01+, `available` was replaced by quantities(names:["available"]).
  quantities: Array<{ name: string; quantity: number }>;
  location: { id: string; name: string };
}

function isInventoryItemNode(n: BulkNode): n is InventoryItemNode {
  return !n.__parentId && n.id.includes("/InventoryItem/");
}

function isInventoryLevelNode(n: BulkNode): n is InventoryLevelNode {
  return (
    !!n.__parentId &&
    Array.isArray((n as InventoryLevelNode).quantities) &&
    typeof (n as InventoryLevelNode).location === "object"
  );
}

/** Extract the "available" quantity from the quantities array. */
function getAvailable(level: InventoryLevelNode): number {
  return level.quantities.find((q) => q.name === "available")?.quantity ?? 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

// ── Main sync ─────────────────────────────────────────────────────────────────

export async function syncInventory(
  client: ShopifyClient,
  tracker: SyncRunTracker,
): Promise<void> {
  logger.info("Starting inventory sync via bulk operation");

  // Load variant GID → DB ID map
  const dbVariants = await db
    .select({ id: variantsTable.id, shopifyGid: variantsTable.shopifyGid, inventoryItemId: variantsTable.inventoryItemId })
    .from(variantsTable);

  const variantByGid = new Map(dbVariants.map((v) => [v.shopifyGid, v]));
  const variantByInventoryItemGid = new Map(
    dbVariants
      .filter((v) => v.inventoryItemId)
      .map((v) => [v.inventoryItemId!, v]),
  );

  // Collect bulk nodes
  const inventoryItems = new Map<string, InventoryItemNode>();
  const levelsByItem = new Map<string, InventoryLevelNode[]>();

  let nodeCount = 0;
  for await (const node of runBulkQuery<BulkNode>(client, BULK_INVENTORY_QUERY)) {
    nodeCount++;
    tracker.bumpApiCalls();

    if (isInventoryItemNode(node)) {
      inventoryItems.set(node.id, node);
    } else if (isInventoryLevelNode(node) && node.__parentId) {
      const list = levelsByItem.get(node.__parentId) ?? [];
      list.push(node);
      levelsByItem.set(node.__parentId, list);
    }
  }

  logger.info({ inventoryItems: inventoryItems.size, totalNodes: nodeCount }, "Inventory bulk complete");

  // Build rows to upsert
  type InventoryInsert = typeof inventoryLevelsTable.$inferInsert;
  const rows: InventoryInsert[] = [];

  for (const [itemGid, item] of inventoryItems) {
    const variantGid = item.variant?.id;
    if (!variantGid) continue;

    const variant = variantByGid.get(variantGid) ?? variantByInventoryItemGid.get(itemGid);
    if (!variant) continue;

    tracker.bumpRead();
    const levels = levelsByItem.get(itemGid) ?? [];

    for (const level of levels) {
      rows.push({
        variantId: variant.id,
        shopifyLocationId: level.location.id,
        locationName: level.location.name,
        available: getAvailable(level),
      });
    }
  }

  // Upsert in batches
  for (const batch of chunks(rows, 200)) {
    await db
      .insert(inventoryLevelsTable)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          inventoryLevelsTable.variantId,
          inventoryLevelsTable.shopifyLocationId,
        ],
        set: {
          available: sql`excluded.available`,
          locationName: sql`excluded.location_name`,
          updatedAt: new Date(),
        },
      });
    tracker.bumpChanged(batch.length);
  }

  logger.info({ rows: rows.length }, "Inventory levels upserted");

  // Update market_variants.availability from aggregated inventory
  await updateMarketAvailability(tracker);
  logger.info("Inventory sync complete");
}

/**
 * Update market_variants.availability based on current inventory levels.
 * Logic: a variant is "in_stock" for a market if total available > 0 across
 * all locations. Future: can be market-specific if location → market mapping exists.
 */
async function updateMarketAvailability(tracker: SyncRunTracker): Promise<void> {
  logger.info("Updating market availability from inventory levels...");

  // Aggregate total available inventory per variant
  const aggregated = await db.execute<{ variant_id: string; total_available: string }>(sql`
    SELECT variant_id, SUM(available) AS total_available
    FROM inventory_levels
    GROUP BY variant_id
  `);

  const rows = (aggregated as unknown as { rows: Array<{ variant_id: string; total_available: string }> }).rows;

  for (const { variant_id, total_available } of rows) {
    const total = parseInt(total_available, 10);
    const availability = total > 0 ? "in_stock" : "out_of_stock";

    await db
      .update(marketVariantsTable)
      .set({ availability, updatedAt: new Date() })
      .where(eq(marketVariantsTable.variantId, variant_id));
  }

  // Also update the variant.available flag
  await db.execute(sql`
    UPDATE variants v
    SET available = (
      SELECT COALESCE(SUM(il.available), 0) > 0
      FROM inventory_levels il
      WHERE il.variant_id = v.id
    ),
    updated_at = NOW()
    WHERE EXISTS (
      SELECT 1 FROM inventory_levels il WHERE il.variant_id = v.id
    )
  `);

  tracker.bumpChanged(rows.length);
  logger.debug({ variantsUpdated: rows.length }, "Market availability updated");
}

// ── Targeted inventory update (for webhook) ──────────────────────────────────

interface InventoryQueryResponse {
  inventoryItem: {
    id: string;
    variant: { id: string } | null;
    inventoryLevels: {
      edges: Array<{
        node: {
          quantities: Array<{ name: string; quantity: number }>;
          location: { id: string; name: string };
        };
      }>;
    };
  } | null;
}

export async function syncSingleInventoryItem(
  client: ShopifyClient,
  inventoryItemGid: string,
  tracker?: SyncRunTracker,
): Promise<void> {
  const result = await client.request<InventoryQueryResponse>(
    SINGLE_INVENTORY_QUERY,
    { inventoryItemId: inventoryItemGid },
    { expectedCost: 10 },
  );

  const item = result.inventoryItem;
  if (!item || !item.variant) {
    logger.warn({ inventoryItemGid }, "Inventory item not found or has no variant");
    return;
  }

  const [variant] = await db
    .select({ id: variantsTable.id })
    .from(variantsTable)
    .where(eq(variantsTable.shopifyGid, item.variant.id))
    .limit(1);

  if (!variant) {
    logger.warn({ variantGid: item.variant.id }, "Variant not in DB — skipping inventory update");
    return;
  }

  for (const { node: level } of item.inventoryLevels.edges) {
    const available = level.quantities.find((q) => q.name === "available")?.quantity ?? 0;
    await db
      .insert(inventoryLevelsTable)
      .values({
        variantId: variant.id,
        shopifyLocationId: level.location.id,
        locationName: level.location.name,
        available,
      })
      .onConflictDoUpdate({
        target: [inventoryLevelsTable.variantId, inventoryLevelsTable.shopifyLocationId],
        set: {
          available,
          locationName: level.location.name,
          updatedAt: new Date(),
        },
      });
  }

  // Update availability in market_variants
  // NOTE: node.available does not exist in 2025-01+; use quantities array.
  const totalAvailable = item.inventoryLevels.edges.reduce(
    (sum, { node }) =>
      sum + (node.quantities.find((q) => q.name === "available")?.quantity ?? 0),
    0,
  );
  const availability = totalAvailable > 0 ? "in_stock" : "out_of_stock";

  await db
    .update(marketVariantsTable)
    .set({ availability, updatedAt: new Date() })
    .where(eq(marketVariantsTable.variantId, variant.id));

  // Update variant.available
  await db
    .update(variantsTable)
    .set({ available: totalAvailable > 0, updatedAt: new Date() })
    .where(eq(variantsTable.id, variant.id));

  tracker?.bumpChanged();
  logger.debug({ inventoryItemGid, totalAvailable }, "Single inventory item updated");
}
