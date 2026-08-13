/**
 * Config validation for bootstrap scripts.
 *
 * Uses the same Zod schemas as the api-server config loader, but lives inside
 * the scripts package to avoid cross-package imports that break tsconfig rootDir.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

// ── Zod schemas ────────────────────────────────────────────────────────────────

const MarketSchema = z.object({
  country: z.string().min(2),
  language: z.enum(["fr", "de", "en", "it"]),
  currency: z.string().length(3),
  label: z.string().optional(),
});

const MarketsConfigSchema = z.object({
  markets: z.record(z.string(), MarketSchema),
  language_masters: z.record(
    z.string(),
    z.object({ markets: z.array(z.string()) }),
  ),
});

const LanguagesConfigSchema = z.object({
  languages: z.array(
    z.object({
      code: z.enum(["fr", "de", "en", "it"]),
      name: z.string(),
      locale: z.string(),
    }),
  ),
});

const StoresConfigSchema = z.object({
  stores: z.record(
    z.string(),
    z.object({
      shopify_location_id: z.string(),
      google_store_code: z.string(),
      name: z.string(),
      address: z.object({
        street: z.string(),
        city: z.string(),
        postal_code: z.string(),
        country: z.string(),
      }),
      phone: z.string().optional(),
      website_url: z.string().optional(),
      pickup_enabled: z.boolean().default(true),
    }),
  ),
});

const ShippingConfigSchema = z.object({
  classes: z.record(
    z.string(),
    z.object({
      label: z.string(),
      description: z.string().optional(),
    }),
  ),
  rates: z.record(z.string(), z.unknown()).default({}),
  default_class: z.string().default("standard"),
});

const ReturnsConfigSchema = z.object({
  classes: z.record(
    z.string(),
    z.object({
      label: z.string(),
      description: z.string().optional(),
      days: z.number().optional(),
      returnable: z.boolean().default(true),
    }),
  ),
  default_class: z.string().default("standard"),
});

const CategoriesConfigSchema = z.object({
  fallback_google_category_id: z.string(),
  fallback_google_category_label: z.string(),
  fallback_meta_category: z.string(),
  mappings: z.array(
    z.object({
      shopify_type: z.string(),
      canonical: z.string(),
      google_category_id: z.string(),
      google_category_label: z.string(),
      meta_category: z.string(),
      indoor_outdoor: z.enum(["indoor", "outdoor", "both"]).optional(),
    }),
  ),
  collection_mappings: z.array(z.unknown()).default([]),
});

const LabelsConfigSchema = z.object({
  lifecycle_values: z.array(z.string()),
  performance_values: z.array(z.string()),
  price_bands: z.array(
    z.object({ key: z.string(), min: z.number(), max: z.number().nullable() }),
  ),
  discount_buckets: z.array(
    z.object({ key: z.string(), min: z.number(), max: z.number().nullable() }),
  ),
  inventory_values: z.array(z.string()),
  new_product_days: z.number().default(60),
});

const FeedPolicyConfigSchema = z.object({
  alerts: z.object({
    item_count_drop_threshold_pct: z.number(),
    price_invalid_threshold_pct: z.number(),
    meta_feed_stale_hours: z.number(),
    stock_stale_hours: z.number(),
    webhook_url: z.string().optional(),
  }),
  snapshot_gate: z.object({
    max_item_count_drop_pct: z.number(),
    require_zero_schema_errors: z.boolean(),
  }),
  dry_run: z.object({
    google: z.boolean(),
    meta: z.boolean(),
  }),
  sync_schedule: z.object({
    full: z.string(),
    prices: z.string(),
    inventory: z.string(),
    recommendations: z.string(),
  }),
  recommendations: z.object({
    top_n: z.number(),
    price_tolerance_pct: z.number(),
    price_tolerance_max_pct: z.number(),
  }),
  bestseller_scoring: z.object({
    sales_30d: z.number(),
    sales_60d: z.number(),
    revenue_normalized: z.number(),
    stock_health: z.number(),
  }),
  conditions: z.object({ new_product_days: z.number() }),
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

const ComplementaryConfigSchema = z.object({
  complementary: z.record(z.string(), z.array(z.string())),
});

// ── Types ──────────────────────────────────────────────────────────────────────

export type ValidatedConfig = {
  markets: z.infer<typeof MarketsConfigSchema>;
  languages: z.infer<typeof LanguagesConfigSchema>;
  stores: z.infer<typeof StoresConfigSchema>;
  shipping: z.infer<typeof ShippingConfigSchema>;
  returns: z.infer<typeof ReturnsConfigSchema>;
  categories: z.infer<typeof CategoriesConfigSchema>;
  labels: z.infer<typeof LabelsConfigSchema>;
  feedPolicy: z.infer<typeof FeedPolicyConfigSchema>;
  complementary: z.infer<typeof ComplementaryConfigSchema>;
};

// ── Loader ─────────────────────────────────────────────────────────────────────

function readYaml(configDir: string, filename: string): unknown {
  const filePath = resolve(configDir, filename);
  try {
    return parseYaml(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read ${filename}: ${String(err)}`);
  }
}

/** Load and Zod-validate all config files. Throws on first schema violation. */
export function loadValidatedConfig(configDir: string): ValidatedConfig {
  return {
    markets: MarketsConfigSchema.parse(readYaml(configDir, "markets.yaml")),
    languages: LanguagesConfigSchema.parse(
      readYaml(configDir, "languages.yaml"),
    ),
    stores: StoresConfigSchema.parse(readYaml(configDir, "stores.yaml")),
    shipping: ShippingConfigSchema.parse(readYaml(configDir, "shipping.yaml")),
    returns: ReturnsConfigSchema.parse(readYaml(configDir, "returns.yaml")),
    categories: CategoriesConfigSchema.parse(
      readYaml(configDir, "categories.yaml"),
    ),
    labels: LabelsConfigSchema.parse(readYaml(configDir, "labels.yaml")),
    feedPolicy: FeedPolicyConfigSchema.parse(
      readYaml(configDir, "feed-policy.yaml"),
    ),
    complementary: ComplementaryConfigSchema.parse(
      readYaml(configDir, "complementary.yaml"),
    ),
  };
}
