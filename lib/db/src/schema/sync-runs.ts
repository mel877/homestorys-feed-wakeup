import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const syncRunsTable = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runType: text("run_type").notNull(), // full | inventory | prices | recommendations | webhook
    status: text("status").notNull().default("running"), // running | completed | failed | cancelled
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    recordsRead: integer("records_read").notNull().default(0),
    recordsChanged: integer("records_changed").notNull().default(0),
    recordsCreated: integer("records_created").notNull().default(0),
    recordsDeleted: integer("records_deleted").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    warnings: integer("warnings").notNull().default(0),
    apiCalls: integer("api_calls").notNull().default(0),
    durationMs: integer("duration_ms"),
    checkpoint: jsonb("checkpoint"), // resumability cursor data
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sync_runs_run_type_idx").on(t.runType),
    index("sync_runs_status_idx").on(t.status),
    index("sync_runs_started_at_idx").on(t.startedAt),
  ],
);

export const syncErrorsTable = pgTable(
  "sync_errors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    syncRunId: uuid("sync_run_id").references(() => syncRunsTable.id, {
      onDelete: "set null",
    }),
    errorType: text("error_type").notNull(),
    entityType: text("entity_type"), // product | variant | image | inventory | feed
    entityId: text("entity_id"),
    marketCode: text("market_code"),
    message: text("message").notNull(),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sync_errors_run_id_idx").on(t.syncRunId),
    index("sync_errors_type_idx").on(t.errorType),
    index("sync_errors_created_at_idx").on(t.createdAt),
  ],
);

export const insertSyncRunSchema = createInsertSchema(syncRunsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSyncRun = z.infer<typeof insertSyncRunSchema>;
export type SyncRun = typeof syncRunsTable.$inferSelect;

export const insertSyncErrorSchema = createInsertSchema(syncErrorsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSyncError = z.infer<typeof insertSyncErrorSchema>;
export type SyncError = typeof syncErrorsTable.$inferSelect;
