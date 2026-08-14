#!/usr/bin/env node
/**
 * CLI entry point for: pnpm sync:google
 *
 * Runs the full Google export cycle:
 *   1. Read canonicals from DB
 *   2. Generate TSV snapshots → App Storage
 *   3. Atomic publish (item-count gate)
 *   4. Upsert to Google Merchant Center (unless GOOGLE_DRY_RUN=true)
 *   5. Sync local inventory (Eupen showroom)
 *
 * Usage:
 *   pnpm sync:google
 *   GOOGLE_DRY_RUN=false pnpm sync:google
 *   pnpm sync:google --markets BE_FR,BE_DE
 *
 * Exit codes: 0 = success, 1 = failure
 */

import { runGoogleExport } from "../exporters/google/runner";

async function main() {
  // Parse --markets flag — supports both forms:
  //   --markets=BE_FR,BE_DE   (equals form)
  //   --markets BE_FR,BE_DE   (space form)
  let markets: string[] | undefined;
  const argv = process.argv.slice(2);
  const marketsEqArg = argv.find((a) => a.startsWith("--markets="));
  const marketsSpaceIdx = argv.indexOf("--markets");
  if (marketsEqArg) {
    markets = marketsEqArg.replace("--markets=", "").split(",").filter(Boolean);
  } else if (marketsSpaceIdx !== -1 && argv[marketsSpaceIdx + 1]) {
    markets = argv[marketsSpaceIdx + 1]!.split(",").filter(Boolean);
  }

  const dryRun = process.env["GOOGLE_DRY_RUN"] !== "false";
  console.log(`\n🚀 Google Feed Sync — ${dryRun ? "DRY RUN" : "LIVE"}\n`);
  if (markets) console.log(`   Markets: ${markets.join(", ")}`);

  try {
    const result = await runGoogleExport({ markets });

    console.log(`\n✅ Google export complete (${result.durationMs}ms)`);
    console.log(`   Total canonicals: ${result.totalCanonicals}`);
    console.log(`   Markets processed: ${result.markets.length}`);

    for (const [market, stats] of Object.entries(result.byMarket)) {
      const icon = stats.published ? "✔" : "⚠";
      console.log(
        `   ${icon} ${market} (${stats.language}/${stats.country}): ${stats.rows} rows` +
          (stats.published ? ` → ${stats.storagePath} | ${stats.publicUrl}` : " [NOT published]"),
      );
    }

    if (result.localInventory.submitted > 0 || result.localInventory.failed > 0) {
      console.log(
        `   Local inventory: ${result.localInventory.submitted} submitted, ${result.localInventory.failed} failed`,
      );
    }

    if (dryRun) {
      console.log("\n   ℹ  Set GOOGLE_DRY_RUN=false to push to Google Merchant Center");
    }

    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Google export failed: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
