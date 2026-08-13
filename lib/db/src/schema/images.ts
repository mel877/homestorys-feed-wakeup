import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  numeric,
  index,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";
import { variantsTable } from "./variants";

export const imagesTable = pgTable(
  "images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => variantsTable.id, {
      onDelete: "set null",
    }),
    shopifyGid: text("shopify_gid"),
    url: text("url").notNull(),
    urlHash: text("url_hash").notNull(),
    altText: text("alt_text"),
    position: integer("position").notNull().default(1),
    width: integer("width"),
    height: integer("height"),
    // Image analysis — computed by image classifier (sharp)
    imageType: text("image_type"), // lifestyle | packshot_white | packshot_solid | packshot_transparent | detail | invalid | unknown
    whiteBgScore: numeric("white_bg_score", { precision: 5, scale: 4 }),
    solidBgScore: numeric("solid_bg_score", { precision: 5, scale: 4 }),
    alphaRatio: numeric("alpha_ratio", { precision: 5, scale: 4 }),
    edgeDensity: numeric("edge_density", { precision: 5, scale: 4 }),
    variance: numeric("variance", { precision: 10, scale: 4 }),
    resolutionScore: numeric("resolution_score", { precision: 5, scale: 4 }),
    isClassified: boolean("is_classified").notNull().default(false),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("images_product_id_idx").on(t.productId),
    index("images_url_hash_idx").on(t.urlHash),
    index("images_image_type_idx").on(t.imageType),
  ],
);

export const insertImageSchema = createInsertSchema(imagesTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertImage = z.infer<typeof insertImageSchema>;
export type Image = typeof imagesTable.$inferSelect;
