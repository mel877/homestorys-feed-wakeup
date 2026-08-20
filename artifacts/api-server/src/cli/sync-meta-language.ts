#!/usr/bin/env node
/**
 * Publishes one public flat Meta language feed in a dedicated Node process.
 * Kept separate from the layer export because each full language CSV is large.
 */
import { loadConfig } from "../config/loader";
import { resolveMetaDryRun } from "../exporters/dry-run";
import { publishMetaLanguageFeeds } from "../exporters/meta/language-feeds";

function optionValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const equals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const language = optionValue("--language");
  if (language !== "fr" && language !== "de") {
    throw new Error("--language must be 'fr' or 'de'");
  }

  const syncRunId = optionValue("--sync-run-id");
  const config = await loadConfig();
  const dryRun = resolveMetaDryRun(config);
  console.log(`\n🚀 Meta ${language.toUpperCase()} public feed — ${dryRun ? "DRY RUN" : "LIVE"}\n`);
  const results = await publishMetaLanguageFeeds(config, {
    languages: [language],
    syncRunId,
    dryRun,
  });
  const result = results[language];
  if (!result?.published) {
    throw new Error(result?.error ?? `Meta ${language.toUpperCase()} public feed was not published`);
  }
  console.log(`\n✅ Meta ${language.toUpperCase()} public feed complete (${result.rows} rows)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});