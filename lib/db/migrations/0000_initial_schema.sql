-- Initial schema migration
-- Captures the full database schema, including columns that were previously
-- added directly via psql ALTER TABLE without a corresponding migration:
--   • webhook_events.updated_at
--   • webhook_events.retry_after
--   • product_translations UNIQUE(product_id, language)
--
-- Running `pnpm run migrate` from the workspace root will apply this file
-- on a fresh database and reproduce the exact live schema.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "shopify_gid"      text        NOT NULL UNIQUE,
  "shopify_id"       text        NOT NULL,
  "handle"           text        NOT NULL,
  "vendor"           text,
  "product_type"     text,
  "tags"             text[]      NOT NULL DEFAULT '{}',
  "status"           text        NOT NULL DEFAULT 'active',
  "published_at"     timestamptz,
  "checksum"         text,
  "source_updated_at" timestamptz,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_shopify_id_idx"  ON "products" ("shopify_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_vendor_idx"      ON "products" ("vendor");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_status_idx"      ON "products" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_updated_at_idx"  ON "products" ("updated_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_translations" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"  uuid        NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "language"    text        NOT NULL,
  "title"       text        NOT NULL,
  "description" text,
  "handle"      text,
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "product_translations_product_lang_unique" UNIQUE ("product_id", "language")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "variants" (
  "id"                              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"                      uuid        NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "shopify_gid"                     text        NOT NULL UNIQUE,
  "shopify_id"                      text        NOT NULL,
  "sku"                             text,
  "title"                           text        NOT NULL,
  "position"                        integer     NOT NULL DEFAULT 1,
  "gtin"                            text,
  "mpn"                             text,
  "inventory_item_id"               text,
  "weight"                          numeric(10, 3),
  "weight_unit"                     text,
  "requires_shipping"               boolean     NOT NULL DEFAULT true,
  "taxable"                         boolean     NOT NULL DEFAULT true,
  "available"                       boolean     NOT NULL DEFAULT false,
  "metafield_outlet"                boolean,
  "metafield_exhibition_model"      boolean,
  "metafield_exhibition_store"      text,
  "metafield_bestseller"            boolean,
  "metafield_discontinued"          boolean,
  "metafield_shipping_class"        text,
  "metafield_return_class"          text,
  "metafield_google_category"       text,
  "metafield_meta_category"         text,
  "metafield_material"              text[],
  "metafield_style"                 text[],
  "metafield_room"                  text[],
  "metafield_indoor_outdoor"        text,
  "metafield_lifestyle_image_override" text,
  "metafield_primary_image_override"   text,
  "raw_metafields"                  jsonb,
  "checksum"                        text,
  "source_updated_at"               timestamptz,
  "created_at"                      timestamptz NOT NULL DEFAULT now(),
  "updated_at"                      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variants_product_id_idx"   ON "variants" ("product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variants_shopify_id_idx"   ON "variants" ("shopify_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variants_sku_idx"          ON "variants" ("sku");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variants_checksum_idx"     ON "variants" ("checksum");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variants_updated_at_idx"   ON "variants" ("updated_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market_variants" (
  "id"                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "variant_id"            uuid        NOT NULL REFERENCES "variants"("id") ON DELETE CASCADE,
  "market_code"           text        NOT NULL,
  "price_amount"          numeric(12, 4),
  "price_currency"        text,
  "compare_at_price_amount" numeric(12, 4),
  "availability"          text        NOT NULL DEFAULT 'out_of_stock',
  "product_url"           text,
  "is_eligible"           boolean     NOT NULL DEFAULT true,
  "exclusion_reason"      text,
  "updated_at"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "market_variants_variant_market_unique" UNIQUE ("variant_id", "market_code")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_variants_market_code_idx"   ON "market_variants" ("market_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_variants_availability_idx"  ON "market_variants" ("availability");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "images" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"       uuid        NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "variant_id"       uuid        REFERENCES "variants"("id") ON DELETE SET NULL,
  "shopify_gid"      text,
  "url"              text        NOT NULL,
  "url_hash"         text        NOT NULL,
  "alt_text"         text,
  "position"         integer     NOT NULL DEFAULT 1,
  "width"            integer,
  "height"           integer,
  "image_type"       text,
  "white_bg_score"   numeric(5, 4),
  "solid_bg_score"   numeric(5, 4),
  "alpha_ratio"      numeric(5, 4),
  "edge_density"     numeric(5, 4),
  "variance"         numeric(10, 4),
  "resolution_score" numeric(5, 4),
  "is_classified"    boolean     NOT NULL DEFAULT false,
  "classified_at"    timestamptz,
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "images_product_id_idx"  ON "images" ("product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "images_url_hash_idx"    ON "images" ("url_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "images_image_type_idx"  ON "images" ("image_type");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_levels" (
  "id"                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "variant_id"            uuid        NOT NULL REFERENCES "variants"("id") ON DELETE CASCADE,
  "shopify_location_id"   text        NOT NULL,
  "location_name"         text,
  "available"             integer     NOT NULL DEFAULT 0,
  "updated_at"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_levels_variant_location_unique" UNIQUE ("variant_id", "shopify_location_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_levels_location_idx"   ON "inventory_levels" ("shopify_location_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_levels_available_idx"  ON "inventory_levels" ("available");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_runs" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_type"         text        NOT NULL,
  "status"           text        NOT NULL DEFAULT 'running',
  "started_at"       timestamptz NOT NULL DEFAULT now(),
  "finished_at"      timestamptz,
  "records_read"     integer     NOT NULL DEFAULT 0,
  "records_changed"  integer     NOT NULL DEFAULT 0,
  "records_created"  integer     NOT NULL DEFAULT 0,
  "records_deleted"  integer     NOT NULL DEFAULT 0,
  "errors"           integer     NOT NULL DEFAULT 0,
  "warnings"         integer     NOT NULL DEFAULT 0,
  "api_calls"        integer     NOT NULL DEFAULT 0,
  "duration_ms"      integer,
  "checkpoint"       jsonb,
  "metadata"         jsonb,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_runs_run_type_idx"   ON "sync_runs" ("run_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_runs_status_idx"     ON "sync_runs" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_runs_started_at_idx" ON "sync_runs" ("started_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_errors" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "sync_run_id"  uuid        REFERENCES "sync_runs"("id") ON DELETE SET NULL,
  "error_type"   text        NOT NULL,
  "entity_type"  text,
  "entity_id"    text,
  "market_code"  text,
  "message"      text        NOT NULL,
  "details"      jsonb,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_errors_run_id_idx"     ON "sync_errors" ("sync_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_errors_type_idx"       ON "sync_errors" ("error_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_errors_created_at_idx" ON "sync_errors" ("created_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feed_items" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "variant_id"          uuid        NOT NULL REFERENCES "variants"("id") ON DELETE CASCADE,
  "market_code"         text        NOT NULL,
  "language"            text        NOT NULL,
  "channel"             text        NOT NULL,
  "canonical_json"      jsonb,
  "is_eligible"         boolean     NOT NULL DEFAULT true,
  "exclusion_reason"    text,
  "data_quality_score"  numeric(5, 2),
  "checksum"            text,
  "generated_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "feed_items_variant_market_lang_channel_unique" UNIQUE ("variant_id", "market_code", "language", "channel")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_items_market_channel_idx"  ON "feed_items" ("market_code", "channel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_items_is_eligible_idx"     ON "feed_items" ("is_eligible");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_items_checksum_idx"        ON "feed_items" ("checksum");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_items_updated_at_idx"      ON "feed_items" ("updated_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recommendations" (
  "id"                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"               uuid        NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "market_code"              text        NOT NULL,
  "related_product_ids"      text[]      NOT NULL DEFAULT '{}',
  "complementary_product_ids" text[]     NOT NULL DEFAULT '{}',
  "generated_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "recommendations_product_market_unique" UNIQUE ("product_id", "market_code")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recommendations_product_id_idx"  ON "recommendations" ("product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recommendations_market_code_idx" ON "recommendations" ("market_code");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_diagnostics" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel"             text        NOT NULL,
  "market_code"         text,
  "product_id_external" text,
  "variant_id"          uuid        REFERENCES "variants"("id") ON DELETE SET NULL,
  "issue_type"          text        NOT NULL,
  "severity"            text        NOT NULL DEFAULT 'error',
  "message"             text        NOT NULL,
  "details"             jsonb,
  "fetched_at"          timestamptz NOT NULL DEFAULT now(),
  "resolved_at"         timestamptz,
  "created_at"          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_diagnostics_channel_idx"     ON "channel_diagnostics" ("channel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_diagnostics_market_idx"      ON "channel_diagnostics" ("market_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_diagnostics_severity_idx"    ON "channel_diagnostics" ("severity");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_diagnostics_fetched_at_idx"  ON "channel_diagnostics" ("fetched_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_diagnostics_resolved_at_idx" ON "channel_diagnostics" ("resolved_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feed_snapshots" (
  "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel"       text        NOT NULL,
  "language"      text,
  "market_code"   text,
  "storage_path"  text        NOT NULL,
  "item_count"    integer     NOT NULL DEFAULT 0,
  "sha256"        text,
  "is_current"    boolean     NOT NULL DEFAULT false,
  "sync_run_id"   uuid        REFERENCES "sync_runs"("id") ON DELETE SET NULL,
  "generated_at"  timestamptz NOT NULL DEFAULT now(),
  "created_at"    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_snapshots_channel_lang_market_idx" ON "feed_snapshots" ("channel", "language", "market_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_snapshots_is_current_idx"          ON "feed_snapshots" ("is_current");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_snapshots_generated_at_idx"        ON "feed_snapshots" ("generated_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_versions" (
  "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "config_key"    text        NOT NULL,
  "version_hash"  text        NOT NULL,
  "content"       jsonb,
  "deployed_at"   timestamptz NOT NULL DEFAULT now(),
  "created_at"    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_versions_config_key_idx"   ON "config_versions" ("config_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_versions_deployed_at_idx"  ON "config_versions" ("deployed_at");

--> statement-breakpoint
-- webhook_events: includes updated_at and retry_after which were previously
-- added directly via psql ALTER TABLE and were missing from the original schema.
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "shopify_webhook_id"  text        NOT NULL UNIQUE,
  "topic"               text        NOT NULL,
  "shopify_domain"      text,
  "payload"             jsonb,
  "status"              text        NOT NULL DEFAULT 'pending',
  "processed_at"        timestamptz,
  "error"               text,
  "retry_count"         integer     NOT NULL DEFAULT 0,
  "retry_after"         timestamptz,
  "updated_at"          timestamptz DEFAULT now(),
  "created_at"          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_status_idx"     ON "webhook_events" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_topic_idx"      ON "webhook_events" ("topic");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_created_at_idx" ON "webhook_events" ("created_at");
