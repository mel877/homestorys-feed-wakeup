import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  uuid,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { variantsTable } from "./variants";

export const inventoryLevelsTable = pgTable(
  "inventory_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variantsTable.id, { onDelete: "cascade" }),
    shopifyLocationId: text("shopify_location_id").notNull(),
    locationName: text("location_name"),
    available: integer("available").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("inventory_levels_variant_location_unique").on(
      t.variantId,
      t.shopifyLocationId,
    ),
    index("inventory_levels_location_idx").on(t.shopifyLocationId),
    index("inventory_levels_available_idx").on(t.available),
  ],
);

export const insertInventoryLevelSchema = createInsertSchema(
  inventoryLevelsTable,
).omit({ id: true, updatedAt: true });
export type InsertInventoryLevel = z.infer<typeof insertInventoryLevelSchema>;
export type InventoryLevel = typeof inventoryLevelsTable.$inferSelect;
