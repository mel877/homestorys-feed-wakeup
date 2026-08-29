CREATE TABLE IF NOT EXISTS "feed_export_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sync_run_id" uuid NOT NULL,
  "channel" text NOT NULL,
  "stage" text NOT NULL,
  "market_code" text DEFAULT '' NOT NULL,
  "language" text DEFAULT '' NOT NULL,
  "batch_index" integer NOT NULL,
  "cursor" jsonb,
  "checkpoint" jsonb,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "available_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "last_error" text,
  "item_count" integer,
  "artifact_path" text,
  "sha256" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "feed_export_steps_run_scope_batch_unique"
    UNIQUE("sync_run_id","channel","stage","market_code","language","batch_index")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feed_export_steps"
 ADD CONSTRAINT "feed_export_steps_sync_run_id_sync_runs_id_fk"
 FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id")
 ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_export_steps_claim_idx"
 ON "feed_export_steps" ("status","available_at","lease_expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_export_steps_run_idx"
 ON "feed_export_steps" ("sync_run_id","channel","status");