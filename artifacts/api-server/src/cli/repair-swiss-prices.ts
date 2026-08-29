#!/usr/bin/env node
/**
 * Targeted Swiss contextual-price repair.
 *
 * This command never runs a feed export or a Shopify full sync.
 *
 * Preview only:
 *   pnpm repair:swiss-prices
 *
 * Apply the atomic CH_DE + CH_FR correction:
 *   pnpm repair:swiss-prices --apply
 */

import { loadConfig } from "../config";
import { getShopifyClient } from "../shopify/client";
import {
  runSwissPriceRepair,
  SwissPriceValidationError,
} from "../shopify/swiss-price-repair";

const apply = process.argv.includes("--apply");

try {
  const report = await runSwissPriceRepair({
    config: loadConfig(),
    client: getShopifyClient(),
    apply,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!apply) {
    console.log("\nPreview complete. No database rows were modified; pass --apply to correct them.");
  }
} catch (error) {
  if (error instanceof SwissPriceValidationError) {
    console.error(JSON.stringify({
      status: "aborted-before-write",
      issueCount: error.issues.length,
      issues: error.issues,
      noCurrencyConversionPerformed: true,
    }, null, 2));
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exitCode = 1;
}