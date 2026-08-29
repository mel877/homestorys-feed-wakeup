import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uuid,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { syncRunsTable } from "./sync-runs";

export const feedExportSourceBatchesTable = pgTable(
  "feed_export_source_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    syncRunId: uuid("sync_run_id")
      .notNull()
      .references(() => syncRunsTable.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    batchIndex: integer("batch_index").notNull(),
    productIds: jsonb("product_ids").notNull(),
    sourceMarkets: jsonb("source_markets").notNull(),
    status: text("status").notNull().default("freezing"), // freezing | complete
    sourceHash: text("source_hash"),
    rowCount: integer("row_count"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("feed_export_source_batches_run_channel_batch_unique").on(
      t.syncRunId,
      t.channel,
      t.batchIndex,
    ),
    index("feed_export_source_batches_run_idx").on(t.syncRunId, t.channel, t.status),
  ],
);

export const feedExportSourceRowsTable = pgTable(
  "feed_export_source_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceBatchId: uuid("source_batch_id")
      .notNull()
      .references(() => feedExportSourceBatchesTable.id, { onDelete: "cascade" }),
    rowIndex: integer("row_index").notNull(),
    canonicalId: text("canonical_id").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    marketCode: text("market_code").notNull(),
    language: text("language").notNull(),
    canonicalJson: jsonb("canonical_json").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("feed_export_source_rows_batch_row_unique").on(
      t.sourceBatchId,
      t.rowIndex,
    ),
    index("feed_export_source_rows_batch_idx").on(t.sourceBatchId, t.marketCode),
  ],
);

export const insertFeedExportSourceBatchSchema = createInsertSchema(
  feedExportSourceBatchesTable,
).omit({ id: true, createdAt: true });
export type InsertFeedExportSourceBatch = z.infer<
  typeof insertFeedExportSourceBatchSchema
>;
export type FeedExportSourceBatch = typeof feedExportSourceBatchesTable.$inferSelect;

export const insertFeedExportSourceRowSchema = createInsertSchema(
  feedExportSourceRowsTable,
).omit({ id: true, createdAt: true });
export type InsertFeedExportSourceRow = z.infer<
  typeof insertFeedExportSourceRowSchema
>;
export type FeedExportSourceRow = typeof feedExportSourceRowsTable.$inferSelect;