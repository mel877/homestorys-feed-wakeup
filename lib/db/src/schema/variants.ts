import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  numeric,
  index,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";

export const variantsTable = pgTable(
  "variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    shopifyGid: text("shopify_gid").notNull().unique(),
    shopifyId: text("shopify_id").notNull(),
    sku: text("sku"),
    title: text("title").notNull(),
    position: integer("position").notNull().default(1),
    gtin: text("gtin"), // barcode — never invented
    mpn: text("mpn"), // from feed.mpn metafield
    inventoryItemId: text("inventory_item_id"),
    weight: numeric("weight", { precision: 10, scale: 3 }),
    weightUnit: text("weight_unit"), // kg | g | lb | oz
    requiresShipping: boolean("requires_shipping").notNull().default(true),
    taxable: boolean("taxable").notNull().default(true),
    available: boolean("available").notNull().default(false),
    // Metafields (feed.* namespace)
    metafieldOutlet: boolean("metafield_outlet"),
    metafieldExhibitionModel: boolean("metafield_exhibition_model"),
    metafieldExhibitionStore: text("metafield_exhibition_store"),
    metafieldBestseller: boolean("metafield_bestseller"),
    metafieldDiscontinued: boolean("metafield_discontinued"),
    metafieldShippingClass: text("metafield_shipping_class"),
    metafieldReturnClass: text("metafield_return_class"),
    metafieldGoogleCategory: text("metafield_google_category"),
    metafieldMetaCategory: text("metafield_meta_category"),
    metafieldMaterial: text("metafield_material").array(),
    metafieldStyle: text("metafield_style").array(),
    metafieldRoom: text("metafield_room").array(),
    metafieldIndoorOutdoor: text("metafield_indoor_outdoor"),
    metafieldLifestyleImageOverride: text("metafield_lifestyle_image_override"),
    metafieldPrimaryImageOverride: text("metafield_primary_image_override"),
    rawMetafields: jsonb("raw_metafields"), // full metafield snapshot
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
    index("variants_product_id_idx").on(t.productId),
    index("variants_shopify_id_idx").on(t.shopifyId),
    index("variants_sku_idx").on(t.sku),
    index("variants_checksum_idx").on(t.checksum),
    index("variants_updated_at_idx").on(t.updatedAt),
  ],
);

export const insertVariantSchema = createInsertSchema(variantsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertVariant = z.infer<typeof insertVariantSchema>;
export type Variant = typeof variantsTable.$inferSelect;
