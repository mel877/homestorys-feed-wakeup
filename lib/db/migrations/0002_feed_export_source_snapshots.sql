CREATE TABLE IF NOT EXISTS "feed_export_source_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sync_run_id" uuid NOT NULL,
  "channel" text NOT NULL,
  "batch_index" integer NOT NULL,
  "product_ids" jsonb NOT NULL,
  "source_markets" jsonb NOT NULL,
  "status" text DEFAULT 'freezing' NOT NULL,
  "source_hash" text,
  "row_count" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "feed_export_source_batches_run_channel_batch_unique"
    UNIQUE("sync_run_id","channel","batch_index")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feed_export_source_batches"
 ADD CONSTRAINT "feed_export_source_batches_sync_run_id_sync_runs_id_fk"
 FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id")
 ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_export_source_batches_run_idx"
 ON "feed_export_source_batches" ("sync_run_id","channel","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feed_export_source_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_batch_id" uuid NOT NULL,
  "row_index" integer NOT NULL,
  "canonical_id" text NOT NULL,
  "product_id" uuid NOT NULL,
  "variant_id" uuid NOT NULL,
  "market_code" text NOT NULL,
  "language" text NOT NULL,
  "canonical_json" jsonb NOT NULL,
  "checksum" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "feed_export_source_rows_batch_row_unique"
    UNIQUE("source_batch_id","row_index")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feed_export_source_rows"
 ADD CONSTRAINT "feed_export_source_rows_source_batch_id_fk"
 FOREIGN KEY ("source_batch_id") REFERENCES "feed_export_source_batches"("id")
 ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_export_source_rows_batch_idx"
 ON "feed_export_source_rows" ("source_batch_id","market_code");
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM "feed_snapshots"
    WHERE "is_current" = true
    GROUP BY "channel", coalesce("language", ''), coalesce("market_code", '')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot create current snapshot uniqueness index: duplicate current snapshots exist';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feed_snapshots_one_current_target_unique"
 ON "feed_snapshots" ("channel", coalesce("language", ''), coalesce("market_code", ''))
 WHERE "is_current" = true;