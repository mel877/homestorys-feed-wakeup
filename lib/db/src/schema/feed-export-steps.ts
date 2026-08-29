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

export const feedExportStepsTable = pgTable(
  "feed_export_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    syncRunId: uuid("sync_run_id")
      .notNull()
      .references(() => syncRunsTable.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // google | meta
    stage: text("stage").notNull(), // build | publish | finalize
    marketCode: text("market_code").notNull().default(""),
    language: text("language").notNull().default(""),
    batchIndex: integer("batch_index").notNull(),
    cursor: jsonb("cursor"),
    checkpoint: jsonb("checkpoint"),
    status: text("status").notNull().default("pending"), // pending | running | completed | failed
    attempts: integer("attempts").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    itemCount: integer("item_count"),
    artifactPath: text("artifact_path"),
    sha256: text("sha256"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("feed_export_steps_run_scope_batch_unique").on(
      t.syncRunId,
      t.channel,
      t.stage,
      t.marketCode,
      t.language,
      t.batchIndex,
    ),
    index("feed_export_steps_claim_idx").on(
      t.status,
      t.availableAt,
      t.leaseExpiresAt,
    ),
    index("feed_export_steps_run_idx").on(t.syncRunId, t.channel, t.status),
  ],
);

export const insertFeedExportStepSchema = createInsertSchema(
  feedExportStepsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertFeedExportStep = z.infer<typeof insertFeedExportStepSchema>;
export type FeedExportStep = typeof feedExportStepsTable.$inferSelect;