import {
  db,
  feedExportSourceBatchesTable,
  feedExportSourceRowsTable,
  type FeedExportSourceBatch,
} from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { CanonicalProduct } from "../canonical/types";
import { computeChecksum } from "../shopify/checksums";

const FROZEN_SOURCE_ROW_INSERT_CHUNK_SIZE = 500;

export interface FrozenSourceBatch {
  batch: FeedExportSourceBatch;
  canonicals: CanonicalProduct[];
}

function stableCanonical(canonical: CanonicalProduct): Record<string, unknown> {
  const { generatedAt: _generatedAt, ...stable } = canonical;
  return stable as unknown as Record<string, unknown>;
}

export function frozenSourceHash(canonicals: CanonicalProduct[]): string {
  return computeChecksum(
    [...canonicals]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(stableCanonical),
  );
}

export async function loadFrozenSourceBatch(input: {
  syncRunId: string;
  channel: "google" | "meta";
  batchIndex: number;
  productIds: string[];
  sourceMarkets: string[];
}): Promise<FrozenSourceBatch | null> {
  const [batch] = await db
    .select()
    .from(feedExportSourceBatchesTable)
    .where(and(
      eq(feedExportSourceBatchesTable.syncRunId, input.syncRunId),
      eq(feedExportSourceBatchesTable.channel, input.channel),
      eq(feedExportSourceBatchesTable.batchIndex, input.batchIndex),
      eq(feedExportSourceBatchesTable.status, "complete"),
    ))
    .limit(1);
  if (!batch) return null;
  if (
    JSON.stringify(batch.productIds) !== JSON.stringify(input.productIds) ||
    JSON.stringify(batch.sourceMarkets) !== JSON.stringify(input.sourceMarkets)
  ) {
    throw new Error("Frozen source batch identity does not match the build checkpoint");
  }
  const rows = await db
    .select()
    .from(feedExportSourceRowsTable)
    .where(eq(feedExportSourceRowsTable.sourceBatchId, batch.id))
    .orderBy(asc(feedExportSourceRowsTable.rowIndex));
  const canonicals = rows.map(
    (row) => row.canonicalJson as unknown as CanonicalProduct,
  );
  if (
    rows.length !== batch.rowCount ||
    frozenSourceHash(canonicals) !== batch.sourceHash ||
    rows.some((row, index) =>
      row.rowIndex !== index ||
      row.checksum !== computeChecksum(stableCanonical(canonicals[index]!))
    )
  ) {
    throw new Error("Frozen source batch is corrupt");
  }
  return { batch, canonicals };
}

export async function persistFrozenSourceBatch(input: {
  syncRunId: string;
  channel: "google" | "meta";
  batchIndex: number;
  productIds: string[];
  sourceMarkets: string[];
  canonicals: CanonicalProduct[];
}): Promise<FrozenSourceBatch> {
  const sorted = [...input.canonicals].sort((a, b) => a.id.localeCompare(b.id));
  const sourceHash = frozenSourceHash(sorted);
  await db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(feedExportSourceBatchesTable)
      .values({
        syncRunId: input.syncRunId,
        channel: input.channel,
        batchIndex: input.batchIndex,
        productIds: input.productIds,
        sourceMarkets: input.sourceMarkets,
        status: "freezing",
      })
      .onConflictDoNothing()
      .returning();
    if (!batch) return;
    if (sorted.length > 0) {
      for (
        let chunkStart = 0;
        chunkStart < sorted.length;
        chunkStart += FROZEN_SOURCE_ROW_INSERT_CHUNK_SIZE
      ) {
        const chunk = sorted.slice(
          chunkStart,
          chunkStart + FROZEN_SOURCE_ROW_INSERT_CHUNK_SIZE,
        );
        await tx.insert(feedExportSourceRowsTable).values(chunk.map((canonical, index) => ({
          sourceBatchId: batch.id,
          rowIndex: chunkStart + index,
          canonicalId: canonical.id,
          productId: canonical.productId,
          variantId: canonical.variantId,
          marketCode: canonical.market,
          language: canonical.language,
          canonicalJson: canonical as unknown as Record<string, unknown>,
          checksum: computeChecksum(stableCanonical(canonical)),
        })));
      }
    }
    await tx
      .update(feedExportSourceBatchesTable)
      .set({
        status: "complete",
        sourceHash,
        rowCount: sorted.length,
        completedAt: new Date(),
      })
      .where(eq(feedExportSourceBatchesTable.id, batch.id));
  });
  const frozen = await loadFrozenSourceBatch(input);
  if (!frozen) {
    throw new Error("Frozen source batch could not be persisted");
  }
  return frozen;
}

export async function getOrCreateFrozenSourceBatch(
  input: {
    syncRunId: string;
    channel: "google" | "meta";
    batchIndex: number;
    productIds: string[];
    sourceMarkets: string[];
  },
  createCanonicals: () => Promise<CanonicalProduct[]>,
): Promise<FrozenSourceBatch> {
  const existing = await loadFrozenSourceBatch(input);
  if (existing) return existing;
  return persistFrozenSourceBatch({
    ...input,
    canonicals: await createCanonicals(),
  });
}

export async function computeProductSourceFingerprints(
  productIds: string[],
): Promise<Record<string, string>> {
  if (productIds.length === 0) return {};
  const ids = sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `);
  const result = await db.execute(sql`
    WITH source_rows AS (
      SELECT p.id AS product_id, 'product:' || p.id::text AS row_key, to_jsonb(p)::text AS payload
      FROM products p WHERE p.id IN (${ids})
      UNION ALL
      SELECT v.product_id, 'variant:' || v.id::text, to_jsonb(v)::text
      FROM variants v WHERE v.product_id IN (${ids})
      UNION ALL
      SELECT v.product_id, 'market:' || mv.id::text, to_jsonb(mv)::text
      FROM market_variants mv JOIN variants v ON v.id = mv.variant_id
      WHERE v.product_id IN (${ids})
      UNION ALL
      SELECT pt.product_id, 'translation:' || pt.id::text, to_jsonb(pt)::text
      FROM product_translations pt WHERE pt.product_id IN (${ids})
      UNION ALL
      SELECT i.product_id, 'image:' || i.id::text, to_jsonb(i)::text
      FROM images i WHERE i.product_id IN (${ids})
      UNION ALL
      SELECT v.product_id, 'inventory:' || il.id::text, to_jsonb(il)::text
      FROM inventory_levels il JOIN variants v ON v.id = il.variant_id
      WHERE v.product_id IN (${ids})
      UNION ALL
      SELECT r.product_id, 'recommendation:' || r.id::text, to_jsonb(r)::text
      FROM recommendations r WHERE r.product_id IN (${ids})
    )
    SELECT product_id::text AS product_id,
           md5(string_agg(row_key || ':' || payload, '|' ORDER BY row_key)) AS fingerprint
    FROM source_rows
    GROUP BY product_id
  `);
  return Object.fromEntries(result.rows.map((row) => [
    String((row as Record<string, unknown>).product_id),
    String((row as Record<string, unknown>).fingerprint),
  ]));
}

export async function assertProductSourceFingerprints(
  expected: Record<string, string>,
): Promise<void> {
  const actual = await computeProductSourceFingerprints(Object.keys(expected));
  for (const [productId, fingerprint] of Object.entries(expected)) {
    if (actual[productId] !== fingerprint) {
      throw new Error(`Source changed during feed export for product ${productId}`);
    }
  }
}