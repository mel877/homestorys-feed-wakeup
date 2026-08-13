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

export const productsTable = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopifyGid: text("shopify_gid").notNull().unique(),
    shopifyId: text("shopify_id").notNull(),
    handle: text("handle").notNull(),
    vendor: text("vendor"),
    productType: text("product_type"),
    tags: text("tags").array().notNull().default([]),
    status: text("status").notNull().default("active"), // active | archived | draft
    publishedAt: timestamp("published_at", { withTimezone: true }),
    checksum: text("checksum"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("products_shopify_id_idx").on(t.shopifyId),
    index("products_vendor_idx").on(t.vendor),
    index("products_status_idx").on(t.status),
    index("products_updated_at_idx").on(t.updatedAt),
  ],
);

// Separate table for localized product content (title, description per language)
export const productTranslationsTable = pgTable(
  "product_translations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    language: text("language").notNull(), // fr | de | en | it
    title: text("title").notNull(),
    description: text("description"),
    handle: text("handle"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("product_translations_product_lang_unique").on(t.productId, t.language),
  ],
);

export const insertProductSchema = createInsertSchema(productsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof productsTable.$inferSelect;

export const insertProductTranslationSchema = createInsertSchema(
  productTranslationsTable,
).omit({ id: true, updatedAt: true });
export type InsertProductTranslation = z.infer<
  typeof insertProductTranslationSchema
>;
export type ProductTranslation = typeof productTranslationsTable.$inferSelect;
