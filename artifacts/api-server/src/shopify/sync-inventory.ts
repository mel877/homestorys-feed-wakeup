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
import { eq, inArray, sql } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";
import { loadConfig } from "../config";
import type { ShopifyClient } from "./client";
import { downloadBulkResults, readBulkJsonlSlice, runBulkQuery } from "./bulk-ops";
import type { SyncRunTracker } from "./sync-run-tracker";
import type { BulkNode } from "./types";

const logger = rootLogger.child({ module: "sync-inventory" });
export const MAX_DURABLE_INVENTORY_LINES_PER_SLICE = 1_000;

export interface DurableInventoryGroup {
  parent: InventoryItemNode;
  children: BulkNode[];
  startOffset: number;
}

export async function readDurableInventoryGroups(
  url: string,
  options: {
    byteOffset?: number; maxLines?: number; shouldContinue?: () => boolean | Promise<boolean>;
    fetcher?: typeof fetch;
    pendingGroup?: DurableInventoryGroup | null;
  } = {},
): Promise<{ groups: DurableInventoryGroup[]; pendingGroup: DurableInventoryGroup | null; nextByteOffset: number; eof: boolean }> {
  const offset = options.byteOffset ?? 0;
  const slice = await readBulkJsonlSlice<BulkNode>(url, {
    offset, maxLines: options.maxLines ?? MAX_DURABLE_INVENTORY_LINES_PER_SLICE,
    shouldContinue: options.shouldContinue, fetcher: options.fetcher,
  });
  const groups: DurableInventoryGroup[] = [];
  let current: DurableInventoryGroup | null = options.pendingGroup ?? null;
  for (const line of slice.lines) {
    if (isInventoryItemNode(line.value)) {
      if (current) groups.push(current);
      current = { parent: line.value, children: [], startOffset: line.startOffset };
    } else if (current) current.children.push(line.value);
  }
  if (current && slice.eof) {
    groups.push(current);
    current = null;
  }
  const firstUncommitted = groups[25];
  if (firstUncommitted) {
    return { groups: groups.slice(0, 25), pendingGroup: null, nextByteOffset: firstUncommitted.startOffset, eof: false };
  }
  return {
    groups,
    pendingGroup: current,
    nextByteOffset: slice.nextOffset,
    eof: slice.eof,
  };
}

// ── GraphQL bulk query ────────────────────────────────────────────────────────

// Bulk operations use standard GraphQL connection syntax (edges/node).
// Shopify flattens the JSONL output with __parentId for child records.
// inventoryItem node → __parentId unset; inventoryLevel → __parentId = inventoryItem GID.
export const BULK_INVENTORY_QUERY = `
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

export interface InventorySyncSliceOptions {
  bulkResultUrl?: string;
  startBatchIndex?: number;
  beforeBatch?: () => Promise<boolean>;
  beforeFinalize?: () => Promise<boolean>;
  /** Durable callers fence each committed SQL batch with their step cursor. */
  commitUnit?: (
    cursor: Record<string, unknown>,
    writer: (tx: any) => Promise<void>,
  ) => Promise<void>;
  byteOffset?: number;
  fetcher?: typeof fetch;
  finalized?: boolean;
  pendingInventoryGroup?: DurableInventoryGroup | null;
}

export async function syncInventory(
  client: ShopifyClient,
  tracker: SyncRunTracker,
  options: InventorySyncSliceOptions = {},
): Promise<{ completed: boolean; nextBatchIndex: number; byteOffset?: number; finalized?: boolean; pendingInventoryGroup?: DurableInventoryGroup | null }> {
  if (options.bulkResultUrl && options.commitUnit && options.finalized) {
    return { completed: true, nextBatchIndex: 0, byteOffset: options.byteOffset, finalized: true, pendingInventoryGroup: options.pendingInventoryGroup };
  }
  logger.info("Starting inventory sync via bulk operation");

  let variantByGid = new Map<string, {
    id: string;
    shopifyGid: string;
    inventoryItemId: string | null;
  }>();

  let variantByInventoryItemGid = new Map<string, {
    id: string;
    shopifyGid: string;
    inventoryItemId: string | null;
  }>();

  const durableMode = !!options.bulkResultUrl && !!options.commitUnit;
  const initialPendingInventoryGroup = options.pendingInventoryGroup;
  let durableNextByteOffset: number | undefined;
  let durableEof = false;
  // Collect bulk nodes (legacy only; durable mode reads a bounded prefix).
  const inventoryItems = new Map<string, InventoryItemNode>();
  const levelsByItem = new Map<string, InventoryLevelNode[]>();

  let nodeCount = 0;
  const acceptNode = (node: BulkNode) => {
    nodeCount++;
    tracker.bumpApiCalls();

    if (isInventoryItemNode(node)) {
      inventoryItems.set(node.id, node);
    } else if (isInventoryLevelNode(node) && node.__parentId) {
      const list = levelsByItem.get(node.__parentId) ?? [];
      list.push(node);
      levelsByItem.set(node.__parentId, list);
    }
  };
  if (durableMode) {
    const grouped = await readDurableInventoryGroups(options.bulkResultUrl!, {
      byteOffset: options.byteOffset,
      shouldContinue: options.beforeBatch,
      fetcher: options.fetcher,
      pendingGroup: options.pendingInventoryGroup,
    });
    // Inventory is committed per bounded read; replay starts at a parent
    // boundary if the next parent did not fit.
    const groups = grouped.groups.slice(0, 25);
    for (const group of groups) {
      acceptNode(group.parent);
      for (const child of group.children) acceptNode(child);
    }
    durableNextByteOffset = grouped.groups[25]?.startOffset ?? grouped.nextByteOffset;
    durableEof = grouped.eof && grouped.groups.length <= 25;
    options.pendingInventoryGroup = grouped.pendingGroup;
  } else {
    const bulkNodes = options.bulkResultUrl
      ? downloadBulkResults<BulkNode>(options.bulkResultUrl)
      : runBulkQuery<BulkNode>(client, BULK_INVENTORY_QUERY);
    for await (const node of bulkNodes) acceptNode(node);
  }

  logger.info({ inventoryItems: inventoryItems.size, totalNodes: nodeCount }, "Inventory bulk complete");
  // Load only the variants referenced by this inventory slice.
  const variantGids = [...inventoryItems.values()]
    .map((item) => item.variant?.id)
    .filter((gid): gid is string => typeof gid === "string");

  if (variantGids.length > 0) {
    const dbVariants = await db
      .select({
        id: variantsTable.id,
        shopifyGid: variantsTable.shopifyGid,
        inventoryItemId: variantsTable.inventoryItemId,
      })
      .from(variantsTable)
      .where(inArray(variantsTable.shopifyGid, variantGids));

    variantByGid = new Map(
      dbVariants.map((variant) => [variant.shopifyGid, variant]),
    );

    variantByInventoryItemGid = new Map(
      dbVariants
        .filter((variant) => variant.inventoryItemId)
        .map((variant) => [variant.inventoryItemId!, variant]),
    );
  }
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
  const batches = durableMode ? (rows.length > 0 ? [rows] : []) : chunks(rows, 200);
  for (const [batchIndex, batch] of batches.entries()) {
    if (batchIndex < (options.startBatchIndex ?? 0)) continue;
    if (options.beforeBatch && !await options.beforeBatch()) {
      if (durableMode) {
        return {
          completed: false, nextBatchIndex: 0, byteOffset: options.byteOffset,
          pendingInventoryGroup: initialPendingInventoryGroup, finalized: false,
        };
      }
      return { completed: false, nextBatchIndex: batchIndex };
    }
    const writeBatch = async (tx: any) => tx
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
    if (options.commitUnit) {
      await options.commitUnit(durableMode
        ? {
          byteOffset: durableNextByteOffset ?? options.byteOffset ?? 0,
          ...(options.pendingInventoryGroup ? { pendingInventoryGroup: options.pendingInventoryGroup } : {}),
        }
        : { nextBatchIndex: batchIndex + 1 }, writeBatch);
    } else {
      await writeBatch(db);
    }
    tracker.bumpChanged(batch.length);
  }
  if (durableMode && batches.length === 0 && inventoryItems.size > 0) {
    await options.commitUnit!({
      byteOffset: durableNextByteOffset ?? options.byteOffset ?? 0,
      ...(options.pendingInventoryGroup ? { pendingInventoryGroup: options.pendingInventoryGroup } : {}),
    }, async () => {});
  }
  if (durableMode && !durableEof) {
    if (batches.length === 0 && options.pendingInventoryGroup && inventoryItems.size === 0) {
      await options.commitUnit!({
        byteOffset: durableNextByteOffset ?? options.byteOffset ?? 0,
        pendingInventoryGroup: options.pendingInventoryGroup,
      }, async () => {});
    }
    return {
      completed: false, nextBatchIndex: 0, byteOffset: durableNextByteOffset,
      pendingInventoryGroup: options.pendingInventoryGroup, finalized: false,
    };
  }

  logger.info({ rows: rows.length }, "Inventory levels upserted");

  if (options.beforeFinalize && !await options.beforeFinalize()) {
    return {
      completed: false, nextBatchIndex: batches.length,
      byteOffset: durableNextByteOffset,
    };
  }
  // Update availability and the finalized cursor in one fenced transaction.
  if (durableMode) {
    await options.commitUnit!({
      byteOffset: durableNextByteOffset ?? options.byteOffset ?? 0,
      finalized: true,
    }, async (tx) => updateMarketAvailability(tracker, tx));
  } else {
    await updateMarketAvailability(tracker);
  }
  logger.info("Inventory sync complete");
  return {
    completed: true, nextBatchIndex: batches.length,
    byteOffset: durableNextByteOffset, ...(durableMode ? { finalized: true } : {}),
  };
}

/**
 * Update market_variants.availability based on current inventory levels.
 * Logic: a variant is "in_stock" for a market if total available > 0 across
 * all locations. Future: can be market-specific if location → market mapping exists.
 */
async function updateMarketAvailability(tracker: SyncRunTracker, executor: any = db): Promise<void> {
  logger.info("Updating market availability from inventory levels...");

  // Aggregate total available inventory per variant
  const updated = await executor.execute(sql`
    UPDATE market_variants mv
    SET availability = CASE WHEN stock.total_available > 0 THEN 'in_stock' ELSE 'out_of_stock' END,
        updated_at = NOW()
    FROM (
      SELECT variant_id, COALESCE(SUM(available), 0) AS total_available
      FROM inventory_levels
      GROUP BY variant_id
    ) stock
    WHERE mv.variant_id = stock.variant_id
    RETURNING mv.variant_id
  `);

  // Also update the variant.available flag
  await executor.execute(sql`
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

  const count = (updated as { rows?: unknown[] }).rows?.length ?? 0;
  tracker.bumpChanged(count);
  logger.debug({ variantsUpdated: count }, "Market availability updated");
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
): Promise<string | null> {
  const result = await client.request<InventoryQueryResponse>(
    SINGLE_INVENTORY_QUERY,
    { inventoryItemId: inventoryItemGid },
    { expectedCost: 10 },
  );

  const item = result.inventoryItem;
  if (!item || !item.variant) {
    logger.warn({ inventoryItemGid }, "Inventory item not found or has no variant");
    return null;
  }

  const [variant] = await db
    .select({ id: variantsTable.id, productId: variantsTable.productId })
    .from(variantsTable)
    .where(eq(variantsTable.shopifyGid, item.variant.id))
    .limit(1);

  if (!variant) {
    logger.warn({ variantGid: item.variant.id }, "Variant not in DB — skipping inventory update");
    return null;
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
  return variant.productId;
}
