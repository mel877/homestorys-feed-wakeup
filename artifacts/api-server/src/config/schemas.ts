import { z } from "zod/v4";

// ── Markets ──────────────────────────────────────────────────────────────────

export const MarketSchema = z.object({
  country: z.string().min(2),
  language: z.enum(["fr", "de", "en", "it"]),
  currency: z.string().length(3),
  label: z.string().optional(),
});

export const MarketsConfigSchema = z.object({
  markets: z.record(z.string(), MarketSchema),
  language_masters: z.record(
    z.string(),
    z.object({ markets: z.array(z.string()) }),
  ),
});

export type MarketConfig = z.infer<typeof MarketSchema>;
export type MarketsConfig = z.infer<typeof MarketsConfigSchema>;

// ── Languages ─────────────────────────────────────────────────────────────────

export const LanguageSchema = z.object({
  code: z.enum(["fr", "de", "en", "it"]),
  name: z.string(),
  locale: z.string(),
});

export const LanguagesConfigSchema = z.object({
  languages: z.array(LanguageSchema),
});

export type LanguageConfig = z.infer<typeof LanguageSchema>;
export type LanguagesConfig = z.infer<typeof LanguagesConfigSchema>;

// ── Stores ───────────────────────────────────────────────────────────────────

export const StoreAddressSchema = z.object({
  street: z.string(),
  city: z.string(),
  postal_code: z.string(),
  country: z.string(),
});

export const StoreSchema = z.object({
  shopify_location_id: z.string(),
  google_store_code: z.string(),
  name: z.string(),
  address: StoreAddressSchema,
  phone: z.string().optional(),
  website_url: z.string().optional(),
  pickup_enabled: z.boolean().default(true),
});

export const StoresConfigSchema = z.object({
  stores: z.record(z.string(), StoreSchema),
});

export type StoreConfig = z.infer<typeof StoreSchema>;
export type StoresConfig = z.infer<typeof StoresConfigSchema>;

// ── Shipping ─────────────────────────────────────────────────────────────────

export const ShippingClassSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

export const ShippingConfigSchema = z.object({
  classes: z.record(z.string(), ShippingClassSchema),
  rates: z.record(z.string(), z.unknown()).default({}),
  default_class: z.string().default("standard"),
});

export type ShippingConfig = z.infer<typeof ShippingConfigSchema>;

// ── Returns ───────────────────────────────────────────────────────────────────

export const ReturnClassSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  days: z.number().optional(),
  returnable: z.boolean().default(true),
});

export const ReturnsConfigSchema = z.object({
  classes: z.record(z.string(), ReturnClassSchema),
  default_class: z.string().default("standard"),
});

export type ReturnsConfig = z.infer<typeof ReturnsConfigSchema>;

// ── Categories ───────────────────────────────────────────────────────────────

export const CategoryMappingSchema = z.object({
  shopify_type: z.string(),
  canonical: z.string(),
  google_category_id: z.string(),
  google_category_label: z.string(),
  meta_category: z.string(),
  indoor_outdoor: z.enum(["indoor", "outdoor", "both"]).optional(),
});

export const CategoriesConfigSchema = z.object({
  fallback_google_category_id: z.string(),
  fallback_google_category_label: z.string(),
  fallback_meta_category: z.string(),
  mappings: z.array(CategoryMappingSchema),
  collection_mappings: z.array(z.unknown()).default([]),
});

export type CategoryMapping = z.infer<typeof CategoryMappingSchema>;
export type CategoriesConfig = z.infer<typeof CategoriesConfigSchema>;

// ── Labels ───────────────────────────────────────────────────────────────────

export const PriceBandSchema = z.object({
  key: z.string(),
  min: z.number(),
  max: z.number().nullable(),
});

export const DiscountBucketSchema = z.object({
  key: z.string(),
  min: z.number(),
  max: z.number().nullable(),
});

export const LabelsConfigSchema = z.object({
  lifecycle_values: z.array(z.string()),
  performance_values: z.array(z.string()),
  price_bands: z.array(PriceBandSchema),
  discount_buckets: z.array(DiscountBucketSchema),
  inventory_values: z.array(z.string()),
  new_product_days: z.number().default(60),
});

export type LabelsConfig = z.infer<typeof LabelsConfigSchema>;

// ── Feed Policy ───────────────────────────────────────────────────────────────

export const FeedPolicyConfigSchema = z.object({
  alerts: z.object({
    item_count_drop_threshold_pct: z.number().default(5),
    price_invalid_threshold_pct: z.number().default(2),
    meta_feed_stale_hours: z.number().default(6),
    stock_stale_hours: z.number().default(3),
    webhook_url: z.string().optional(),
  }),
  snapshot_gate: z.object({
    max_item_count_drop_pct: z.number().default(10),
    require_zero_schema_errors: z.boolean().default(true),
  }),
  dry_run: z.object({
    google: z.boolean().default(true),
    meta: z.boolean().default(true),
  }),
  sync_schedule: z.object({
    full: z.string(),
    prices: z.string(),
    inventory: z.string(),
    recommendations: z.string(),
  }),
  recommendations: z.object({
    top_n: z.number().default(8),
    price_tolerance_pct: z.number().default(20),
    price_tolerance_max_pct: z.number().default(40),
  }),
  bestseller_scoring: z.object({
    sales_30d: z.number(),
    sales_60d: z.number(),
    revenue_normalized: z.number(),
    stock_health: z.number(),
  }),
  conditions: z.object({
    new_product_days: z.number().default(60),
  }),
  quality_weights: z.object({
    identity: z.number(),
    pricing: z.number(),
    inventory: z.number(),
    images: z.number(),
    classification: z.number(),
    content: z.number(),
    identifiers: z.number(),
    shipping: z.number(),
  }),
});

export type FeedPolicyConfig = z.infer<typeof FeedPolicyConfigSchema>;

// ── Complementary ──────────────────────────────────────────────────────────────

export const ComplementaryConfigSchema = z.object({
  complementary: z.record(z.string(), z.array(z.string())),
});

export type ComplementaryConfig = z.infer<typeof ComplementaryConfigSchema>;

// ── Unified app config ────────────────────────────────────────────────────────

export interface AppConfig {
  markets: MarketsConfig;
  languages: LanguagesConfig;
  stores: StoresConfig;
  shipping: ShippingConfig;
  returns: ReturnsConfig;
  categories: CategoriesConfig;
  labels: LabelsConfig;
  feedPolicy: FeedPolicyConfig;
  complementary: ComplementaryConfig;
}
