#!/usr/bin/env node
/**
 * CLI entry point: pnpm sync:prices
 *
 * Triggers a price-only sync via the internal API.
 *
 * Usage:
 *   pnpm sync:prices
 *   INTERNAL_API_SECRET=xxx pnpm sync:prices
 */

import { triggerSyncJob } from "./sync-lib";

triggerSyncJob("prices").catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
