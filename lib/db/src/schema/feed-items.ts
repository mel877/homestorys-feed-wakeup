import {
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
  jsonb,
  index,
  uuid,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { variantsTable } from "./variants";

export const feedItemsTable = pgTable(
  "feed_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variantsTable.id, { onDelete: "cascade" }),
    marketCode: text("market_code").notNull(),
    language: text("language").notNull(), // fr | de | en | it
    channel: text("channel").notNull(), // google | meta
    canonicalJson: jsonb("canonical_json"), // full CanonicalProduct snapshot
    isEligible: boolean("is_eligible").notNull().default(true),
    exclusionReason: text("exclusion_reason"),
    dataQualityScore: numeric("data_quality_score", { precision: 5, scale: 2 }),
    checksum: text("checksum"),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("feed_items_variant_market_lang_channel_unique").on(
      t.variantId,
      t.marketCode,
      t.language,
      t.channel,
    ),
    index("feed_items_market_channel_idx").on(t.marketCode, t.channel),
    index("feed_items_is_eligible_idx").on(t.isEligible),
    index("feed_items_checksum_idx").on(t.checksum),
    index("feed_items_updated_at_idx").on(t.updatedAt),
  ],
);

export const insertFeedItemSchema = createInsertSchema(feedItemsTable).omit({
  id: true,
  generatedAt: true,
  updatedAt: true,
});
export type InsertFeedItem = z.infer<typeof insertFeedItemSchema>;
export type FeedItem = typeof feedItemsTable.$inferSelect;
