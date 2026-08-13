#!/usr/bin/env node
/**
 * CLI entry point: pnpm sync:inventory
 *
 * Triggers an inventory-only sync via the internal API.
 *
 * Usage:
 *   pnpm sync:inventory
 *   INTERNAL_API_SECRET=xxx pnpm sync:inventory
 */

import { triggerSyncJob } from "./sync-lib";

triggerSyncJob("inventory").catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
