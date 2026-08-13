#!/usr/bin/env node
/**
 * CLI entry point: pnpm sync:full
 *
 * Triggers a full catalog sync via the internal API and streams progress.
 * Requires INTERNAL_API_SECRET and APP_BASE_URL (or defaults to localhost).
 *
 * Usage:
 *   pnpm sync:full
 *   INTERNAL_API_SECRET=xxx APP_BASE_URL=http://localhost:3000 pnpm sync:full
 */

import { triggerSyncJob } from "./sync-lib";

triggerSyncJob("full").catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
