import {
  pgTable,
  text,
  timestamp,
  index,
  uuid,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";

export const recommendationsTable = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    marketCode: text("market_code").notNull(),
    relatedProductIds: text("related_product_ids").array().notNull().default([]),
    complementaryProductIds: text("complementary_product_ids")
      .array()
      .notNull()
      .default([]),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("recommendations_product_market_unique").on(
      t.productId,
      t.marketCode,
    ),
    index("recommendations_product_id_idx").on(t.productId),
    index("recommendations_market_code_idx").on(t.marketCode),
  ],
);

export const insertRecommendationSchema = createInsertSchema(
  recommendationsTable,
).omit({ id: true, generatedAt: true, updatedAt: true });
export type InsertRecommendation = z.infer<typeof insertRecommendationSchema>;
export type Recommendation = typeof recommendationsTable.$inferSelect;
