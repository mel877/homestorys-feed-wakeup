#!/usr/bin/env node
/**
 * CLI entry point for: pnpm feed:validate
 *
 * Downloads all current feed files from App Storage and validates
 * each row against the JSON schemas in schemas/.
 *
 * Usage:
 *   pnpm feed:validate
 *   pnpm feed:validate --channel google
 *   pnpm feed:validate --channel meta
 *   pnpm feed:validate --file feeds/google/google-fr-BE_FR.tsv
 *
 * Exit codes: 0 = all valid, 1 = schema errors found or failure
 */

import { validateAllFeeds, validateGoogleFeed, validateMetaFeed } from "../validation/feed-validator";
import type { FeedValidationResult } from "../validation/feed-validator";

function printResult(result: FeedValidationResult): void {
  const icon = result.valid ? "✔" : "✘";
  console.log(
    `   ${icon} ${result.file}  [${result.schema}]  ${result.rowCount} rows  ${result.errorCount} errors`,
  );

  if (!result.valid) {
    const shown = result.errors.slice(0, 20);
    for (const err of shown) {
      console.log(`       Row ${err.row}: [${err.field}] ${err.message}`);
    }
    if (result.errors.length > 20) {
      console.log(`       ... and ${result.errors.length - 20} more errors`);
    }
  }
}

async function main() {
  // Support both --flag=value and --flag value forms
  function getFlag(name: string): string | undefined {
    const argv = process.argv.slice(2);
    const eqArg = argv.find((a) => a.startsWith(`--${name}=`));
    if (eqArg) return eqArg.replace(`--${name}=`, "");
    const spaceIdx = argv.indexOf(`--${name}`);
    if (spaceIdx !== -1 && argv[spaceIdx + 1]) return argv[spaceIdx + 1];
    return undefined;
  }
  const channelArg = getFlag("channel");
  const fileArg = getFlag("file");

  console.log("\n🔍 Feed Validator\n");

  try {
    if (fileArg) {
      // Validate a single file
      const isGoogle = fileArg.endsWith(".tsv");
      const result = isGoogle
        ? await validateGoogleFeed(fileArg)
        : await validateMetaFeed(fileArg);
      printResult(result);
      process.exit(result.valid ? 0 : 1);
    }

    const { results, totalErrors, valid } = await validateAllFeeds();

    if (results.length === 0) {
      console.log("   No feed files found in App Storage. Run pnpm sync:google or pnpm sync:meta first.");
      process.exit(0);
    }

    // Optionally filter by channel (meta schemas are: meta-base, meta-language, meta-country, meta-product)
    const filtered = channelArg
      ? results.filter((r) =>
          channelArg === "google"
            ? r.schema === "google-product"
            : r.schema.startsWith("meta-"),
        )
      : results;

    for (const result of filtered) {
      printResult(result);
    }

    console.log(`\n${valid ? "✅" : "❌"} ${filtered.length} files, ${totalErrors} total errors`);
    process.exit(valid ? 0 : 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Validation failed: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
