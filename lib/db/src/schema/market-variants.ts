import {
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
  index,
  uuid,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { variantsTable } from "./variants";

export const marketVariantsTable = pgTable(
  "market_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variantsTable.id, { onDelete: "cascade" }),
    marketCode: text("market_code").notNull(), // BE_FR | BE_DE | FR | DE | AT
    priceAmount: numeric("price_amount", { precision: 12, scale: 4 }),
    priceCurrency: text("price_currency"),
    compareAtPriceAmount: numeric("compare_at_price_amount", {
      precision: 12,
      scale: 4,
    }),
    availability: text("availability").notNull().default("out_of_stock"), // in_stock | out_of_stock | backorder
    productUrl: text("product_url"),
    isEligible: boolean("is_eligible").notNull().default(true),
    exclusionReason: text("exclusion_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("market_variants_variant_market_unique").on(
      t.variantId,
      t.marketCode,
    ),
    index("market_variants_market_code_idx").on(t.marketCode),
    index("market_variants_availability_idx").on(t.availability),
  ],
);

export const insertMarketVariantSchema = createInsertSchema(
  marketVariantsTable,
).omit({ id: true, updatedAt: true });
export type InsertMarketVariant = z.infer<typeof insertMarketVariantSchema>;
export type MarketVariant = typeof marketVariantsTable.$inferSelect;
