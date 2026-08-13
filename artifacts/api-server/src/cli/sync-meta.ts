#!/usr/bin/env node
/**
 * CLI entry point for: pnpm sync:meta
 *
 * Generates the full Meta localized catalog:
 *   meta-base.csv
 *   meta-language-fr.csv / meta-language-de.csv
 *   meta-country-BE.csv / FR / DE / AT
 *
 * Files are written to App Storage under feeds/meta/.
 * In dry-run mode (META_DRY_RUN=true, default), files are uploaded to
 * versioned paths but NOT copied to the current pointer.
 *
 * Usage:
 *   pnpm sync:meta
 *   META_DRY_RUN=false pnpm sync:meta
 *   pnpm sync:meta --markets BE_FR,FR
 *
 * Exit codes: 0 = success, 1 = failure
 */

import { runMetaExport } from "../exporters/meta/generator";

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

  const dryRun = process.env["META_DRY_RUN"] !== "false";
  console.log(`\n🚀 Meta Feed Sync — ${dryRun ? "DRY RUN" : "LIVE"}\n`);
  if (markets) console.log(`   Markets: ${markets.join(", ")}`);

  try {
    const result = await runMetaExport({ markets });

    console.log(`\n✅ Meta export complete (${result.durationMs}ms)`);
    console.log(`   Total canonicals: ${result.totalCanonicals}`);

    for (const [key, stats] of Object.entries(result.files)) {
      const icon = stats.published ? "✔" : "⚠";
      console.log(
        `   ${icon} ${key}: ${stats.itemCount} rows` +
          (stats.published
            ? ` → ${stats.storagePath}`
            : " [versioned, not published]"),
      );
    }

    if (dryRun) {
      console.log("\n   ℹ  Set META_DRY_RUN=false to publish current pointers");
    }

    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Meta export failed: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
