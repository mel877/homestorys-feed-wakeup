import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { variantsTable } from "./variants";

export const channelDiagnosticsTable = pgTable(
  "channel_diagnostics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: text("channel").notNull(), // google | meta
    marketCode: text("market_code"),
    productIdExternal: text("product_id_external"), // Google/Meta product ID
    variantId: uuid("variant_id").references(() => variantsTable.id, {
      onDelete: "set null",
    }),
    issueType: text("issue_type").notNull(), // refusal | price_mismatch | availability_mismatch | gtin | image | landing_page | policy
    severity: text("severity").notNull().default("error"), // critical | error | warning | info
    message: text("message").notNull(),
    details: jsonb("details"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("channel_diagnostics_channel_idx").on(t.channel),
    index("channel_diagnostics_market_idx").on(t.marketCode),
    index("channel_diagnostics_severity_idx").on(t.severity),
    index("channel_diagnostics_fetched_at_idx").on(t.fetchedAt),
    index("channel_diagnostics_resolved_at_idx").on(t.resolvedAt),
  ],
);

export const insertChannelDiagnosticSchema = createInsertSchema(
  channelDiagnosticsTable,
).omit({ id: true, createdAt: true });
export type InsertChannelDiagnostic = z.infer<
  typeof insertChannelDiagnosticSchema
>;
export type ChannelDiagnostic = typeof channelDiagnosticsTable.$inferSelect;
