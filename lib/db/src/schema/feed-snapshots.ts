import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { syncRunsTable } from "./sync-runs";

export const feedSnapshotsTable = pgTable(
  "feed_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: text("channel").notNull(), // google | meta
    language: text("language"), // fr | de | en | it
    marketCode: text("market_code"),
    storagePath: text("storage_path").notNull(), // path in Replit App Storage
    itemCount: integer("item_count").notNull().default(0),
    sha256: text("sha256"),
    isCurrent: boolean("is_current").notNull().default(false),
    syncRunId: uuid("sync_run_id").references(() => syncRunsTable.id, {
      onDelete: "set null",
    }),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("feed_snapshots_channel_lang_market_idx").on(
      t.channel,
      t.language,
      t.marketCode,
    ),
    index("feed_snapshots_is_current_idx").on(t.isCurrent),
    index("feed_snapshots_generated_at_idx").on(t.generatedAt),
    uniqueIndex("feed_snapshots_one_current_target_unique")
      .on(
        t.channel,
        sql`coalesce(${t.language}, '')`,
        sql`coalesce(${t.marketCode}, '')`,
      )
      .where(sql`${t.isCurrent} = true`),
  ],
);

export const insertFeedSnapshotSchema = createInsertSchema(
  feedSnapshotsTable,
).omit({ id: true, createdAt: true });
export type InsertFeedSnapshot = z.infer<typeof insertFeedSnapshotSchema>;
export type FeedSnapshot = typeof feedSnapshotsTable.$inferSelect;
