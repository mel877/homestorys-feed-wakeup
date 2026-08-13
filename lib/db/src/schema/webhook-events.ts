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

export const webhookEventsTable = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Shopify sends X-Shopify-Webhook-Id header — use as idempotency key
    shopifyWebhookId: text("shopify_webhook_id").notNull().unique(),
    topic: text("topic").notNull(), // products/create | products/update | products/delete | inventory_levels/update
    shopifyDomain: text("shopify_domain"),
    payload: jsonb("payload"),
    status: text("status").notNull().default("pending"), // pending | processing | processed | failed
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
    retryCount: integer("retry_count").notNull().default(0),
    // When to retry after a failure — NULL means immediately eligible
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    // Timestamp of last status change (used for stale-processing recovery)
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("webhook_events_status_idx").on(t.status),
    index("webhook_events_topic_idx").on(t.topic),
    index("webhook_events_created_at_idx").on(t.createdAt),
  ],
);

export const insertWebhookEventSchema = createInsertSchema(
  webhookEventsTable,
).omit({ id: true, createdAt: true });
export type InsertWebhookEvent = z.infer<typeof insertWebhookEventSchema>;
export type WebhookEvent = typeof webhookEventsTable.$inferSelect;
