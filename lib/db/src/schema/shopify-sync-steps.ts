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

export const shopifySyncStepsTable = pgTable(
  "shopify_sync_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    syncRunId: uuid("sync_run_id")
      .notNull()
      .references(() => syncRunsTable.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    sequence: integer("sequence").notNull(),
    batchIndex: integer("batch_index").notNull().default(0),
    cursor: jsonb("cursor"),
    checkpoint: jsonb("checkpoint"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("shopify_sync_steps_run_phase_batch_unique").on(
      t.syncRunId,
      t.phase,
      t.batchIndex,
    ),
    index("shopify_sync_steps_claim_idx").on(
      t.status,
      t.availableAt,
      t.leaseExpiresAt,
    ),
    index("shopify_sync_steps_run_idx").on(t.syncRunId, t.sequence, t.status),
  ],
);

export const insertShopifySyncStepSchema = createInsertSchema(
  shopifySyncStepsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertShopifySyncStep = z.infer<typeof insertShopifySyncStepSchema>;
export type ShopifySyncStep = typeof shopifySyncStepsTable.$inferSelect;