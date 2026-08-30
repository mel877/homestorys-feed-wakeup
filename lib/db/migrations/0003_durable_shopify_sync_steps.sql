CREATE TABLE IF NOT EXISTS "shopify_sync_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sync_run_id" uuid NOT NULL,
  "phase" text NOT NULL,
  "sequence" integer NOT NULL,
  "batch_index" integer DEFAULT 0 NOT NULL,
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
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_sync_steps_run_phase_batch_unique"
    UNIQUE("sync_run_id","phase","batch_index")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_sync_steps"
 ADD CONSTRAINT "shopify_sync_steps_sync_run_id_sync_runs_id_fk"
 FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id")
 ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_sync_steps_claim_idx"
 ON "shopify_sync_steps" ("status","available_at","lease_expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_sync_steps_run_idx"
 ON "shopify_sync_steps" ("sync_run_id","sequence","status");