/**
 * Meta Feed Generator
 *
 * Generates the Meta localized catalog CSV architecture:
 *   meta-base.csv              — identity, images, classification (language-agnostic)
 *   meta-language-fr.csv       — French title/description/link
 *   meta-language-de.csv       — German title/description/link
 *   meta-country-BE.csv        — Belgium price+availability
 *   meta-country-FR.csv        — France price+availability
 *   meta-country-DE.csv        — Germany price+availability
 *   meta-country-AT.csv        — Austria price+availability
 *
 * Each file goes through:
 *   1. Generated to versioned path
 *   2. Atomic publish gate (item count threshold)
 *   3. Copied to current path if gate passes
 *   4. feed_snapshots row written to DB
 *
 * Run via: pnpm sync:meta
 * Env: META_DRY_RUN=false to publish (dry-run does everything except the final
 *       atomic copy to the current pointer path).
 */

import { stringify } from "csv-stringify/sync";
import { db, feedSnapshotsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { loadConfig } from "../../config/loader";
import { logger as rootLogger } from "../../lib/logger";
import {
  uploadFeedFile,
  uploadManifest,
  atomicPublish,
  downloadManifest,
  metaFeedPath,
  versionedPath,
  formatVersionTs,
  type FeedManifest,
} from "../../lib/storage";
import { sendFeedBlockAlert, resolveAlertWebhookUrl } from "../../lib/alerting";
import { processAllCanonicals } from "../canonical-reader";
import {
  mapToMeta,
  type MetaBaseRow,
  type MetaLanguageRow,
  type MetaCountryRow,
  META_BASE_HEADERS,
  META_LANGUAGE_HEADERS,
  META_COUNTRY_HEADERS,
} from "./mapper";
import { validateMetaFeed } from "../../validation/feed-validator";
import type { CanonicalProduct } from "../../canonical/types";

const logger = rootLogger.child({ module: "meta-generator" });

export function isDryRun(): boolean {
  return process.env["META_DRY_RUN"] !== "false";
}

// ── Feed files to generate ────────────────────────────────────────────────────

type MetaFeedKey =
  | "base"
  | "language-fr"
  | "language-de"
  | "country-BE"
  | "country-FR"
  | "country-DE"
  | "country-AT";

const META_FEED_FILES: Record<MetaFeedKey, string> = {
  "base":        "meta-base.csv",
  "language-fr": "meta-language-fr.csv",
  "language-de": "meta-language-de.csv",
  "country-BE":  "meta-country-BE.csv",
  "country-FR":  "meta-country-FR.csv",
  "country-DE":  "meta-country-DE.csv",
  "country-AT":  "meta-country-AT.csv",
};

// ── CSV serialization ─────────────────────────────────────────────────────────

function toCsv<T extends object>(
  headers: (keyof T)[],
  rows: T[],
): string {
  const header = headers.map((h) => String(h));
  const data = rows.map((row) => headers.map((h) => String((row as Record<string | symbol, unknown>)[h as string | symbol] ?? "")));
  return stringify([header, ...data]);
}

// ── Main generator ─────────────────────────────────────────────────────────────

export interface MetaRunResult {
  totalCanonicals: number;
  files: Record<
    MetaFeedKey,
    {
      itemCount: number;
      storagePath: string;
      published: boolean;
      sha256: string;
    }
  >;
  dryRun: boolean;
  durationMs: number;
}

export async function runMetaExport(options: {
  markets?: string[];
  syncRunId?: string;
}): Promise<MetaRunResult> {
  const startedAt = Date.now();
  const config = await loadConfig();
  const versionTs = formatVersionTs();
  const dryRun = isDryRun();
  const alertWebhookUrl = resolveAlertWebhookUrl(config.feedPolicy.alerts.webhook_url);

  logger.info({ dryRun, markets: options.markets ?? "all" }, "Meta export starting");

  // ── 1. Stream canonicals → accumulate compact map rows ────────────────────
  //
  // processAllCanonicals never builds a large canonicals[] array — each
  // canonical is mapped immediately and released, keeping peak heap at
  // ~raw-data-maps + compact-row-maps instead of raw-data + all canonicals.
  // Feed-items upserts are batched 100 at a time (vs. one DB round-trip each).
  const baseRows = new Map<string, MetaBaseRow>();       // id → row (deduplicated)
  const langFrRows = new Map<string, MetaLanguageRow>(); // id → row
  const langDeRows = new Map<string, MetaLanguageRow>();
  const countryRows = new Map<string, Map<string, MetaCountryRow>>(); // country → id → row
  let totalCanonicals = 0;

  const { eligible, ineligible, excluded } = await processAllCanonicals(
    config,
    { markets: options.markets, channel: "meta", persistFeedItems: true },
    (canonical) => {
      totalCanonicals++;
      const mapped = mapToMeta(canonical, config);
      if (!mapped) return;

      const { id, language, country, base, language_row, country_row } = mapped;

      // Base: deduplicated by id (identical across markets for same variant)
      if (!baseRows.has(id)) baseRows.set(id, base);

      // Language rows: one per (language × id)
      if (language === "fr") langFrRows.set(id, language_row);
      else if (language === "de") langDeRows.set(id, language_row);

      // Country rows: one per (country × id)
      if (!countryRows.has(country)) countryRows.set(country, new Map());
      countryRows.get(country)!.set(id, country_row);
    },
  );
  logger.info({ eligible, ineligible, excluded, totalCanonicals }, "Canonicals streamed");

  // ── 3. Generate and publish each feed file ─────────────────────────────────
  const feedResults: MetaRunResult["files"] = {} as MetaRunResult["files"];

  async function publishFeed(
    key: MetaFeedKey,
    filename: string,
    headers: string[],
    rows: object[],
    feedLanguage: string | null,
    feedCountry: string | null,
  ): Promise<void> {
    const currentPath = metaFeedPath(filename);
    const versioned = versionedPath(currentPath, versionTs);

    const csv = toCsv(headers as never[], rows as never[]);
    const sha256 = await uploadFeedFile(versioned, csv, "text/csv");

    const manifest: FeedManifest = {
      version: versionTs,
      generatedAt: new Date().toISOString(),
      itemCount: rows.length,
      sha256,
      sourceRunId: options.syncRunId ?? null,
      channel: "meta",
      language: feedLanguage,
      marketCode: feedCountry,
    };
    await uploadManifest(versioned, manifest);

    // Gate: schema validation
    const { snapshot_gate } = config.feedPolicy;
    let schemaValid = true;
    if (snapshot_gate.require_zero_schema_errors) {
      const validation = await validateMetaFeed(versioned);
      schemaValid = validation.valid;
      if (!schemaValid) {
        logger.error(
          { key, errors: validation.errorCount, schema: validation.schema, firstError: validation.errors[0] },
          "Meta feed schema validation FAILED — blocking publish",
        );
        await sendFeedBlockAlert(
          {
            channel: "meta",
            marketOrFile: key,
            previousItemCount: null,
            newItemCount: rows.length,
            dropPct: null,
            reason: "schema_error",
            syncRunId: options.syncRunId ?? null,
          },
          alertWebhookUrl,
        );
      } else {
        logger.debug({ key, rows: validation.rowCount, schema: validation.schema }, "Meta feed schema validation passed");
      }
    }

    // Gate: compare to previous snapshot count
    let previousItemCount: number | null = null;
    const prevManifest = await downloadManifest(currentPath).catch(() => null);
    if (prevManifest) previousItemCount = prevManifest.itemCount;

    const published = (!schemaValid || dryRun)
      ? false // schema invalid or dry-run: versioned uploaded but NOT copied to current
      : await atomicPublish({
          versionedPath: versioned,
          currentPath,
          manifest,
          previousItemCount,
          maxDropPct: snapshot_gate.max_item_count_drop_pct,
          alertWebhookUrl,
        });

    if (dryRun) {
      logger.info({ key, rows: rows.length, versioned, dryRun: true }, "DRY RUN: feed generated (not published)");
    }

    // DB snapshot record
    if (published) {
      await db
        .update(feedSnapshotsTable)
        .set({ isCurrent: false })
        .where(
          and(
            eq(feedSnapshotsTable.channel, "meta"),
            eq(feedSnapshotsTable.storagePath, currentPath),
          ),
        );

      await db.insert(feedSnapshotsTable).values({
        channel: "meta",
        language: feedLanguage,
        marketCode: feedCountry,
        storagePath: currentPath,
        itemCount: rows.length,
        sha256,
        isCurrent: true,
        syncRunId: options.syncRunId ?? null,
        generatedAt: new Date(),
      });
    }

    feedResults[key] = {
      itemCount: rows.length,
      storagePath: published ? currentPath : versioned,
      published: published || dryRun,
      sha256,
    };

    logger.info({ key, rows: rows.length, published }, "Meta feed file complete");
  }

  // ── Determine which files to publish ─────────────────────────────────────────
  //
  // Partial-market runs (options.markets is set) must NOT publish shared layers
  // (base + language), because those layers are built from all markets and would
  // be incomplete for a subset run. Publishing an empty or partial shared layer
  // would overwrite the valid full-catalog current pointer.
  //
  // Only country-specific layers whose target country is represented in the
  // requested markets are published in a partial run.
  const isPartialRun = (options.markets?.length ?? 0) > 0;

  // Countries represented by the loaded canonicals
  const representedCountries = new Set(countryRows.keys());

  // ── Publish feed files SEQUENTIALLY ──────────────────────────────────────────
  //
  // Each publishFeed call serializes a full CSV string (~30–100 MB per file).
  // Running them concurrently via Promise.all would spike memory 7× simultaneously.
  // Sequential publish keeps peak memory to one CSV at a time.
  if (isPartialRun) {
    logger.info(
      { reason: "partial-market run" },
      "Skipping base + language shared layers — not safe to publish partial catalog",
    );
    feedResults["base"] = { itemCount: baseRows.size, storagePath: versionedPath(metaFeedPath(META_FEED_FILES["base"]), versionTs), published: false, sha256: "" };
    feedResults["language-fr"] = { itemCount: langFrRows.size, storagePath: versionedPath(metaFeedPath(META_FEED_FILES["language-fr"]), versionTs), published: false, sha256: "" };
    feedResults["language-de"] = { itemCount: langDeRows.size, storagePath: versionedPath(metaFeedPath(META_FEED_FILES["language-de"]), versionTs), published: false, sha256: "" };
  } else {
    await publishFeed("base", META_FEED_FILES["base"], META_BASE_HEADERS, [...baseRows.values()], null, null);
    await publishFeed("language-fr", META_FEED_FILES["language-fr"], META_LANGUAGE_HEADERS, [...langFrRows.values()], "fr", null);
    await publishFeed("language-de", META_FEED_FILES["language-de"], META_LANGUAGE_HEADERS, [...langDeRows.values()], "de", null);
  }

  for (const country of ["BE", "FR", "DE", "AT"]) {
    const key = `country-${country}` as MetaFeedKey;
    const filename = META_FEED_FILES[key];
    const rows = [...(countryRows.get(country)?.values() ?? [])];

    if (isPartialRun && !representedCountries.has(country)) {
      logger.info({ country, reason: "country not in partial run markets" }, "Skipping country layer publish");
      feedResults[key] = { itemCount: 0, storagePath: metaFeedPath(filename), published: false, sha256: "" };
      continue;
    }

    await publishFeed(key, filename, META_COUNTRY_HEADERS, rows, null, country);
  }

  const result: MetaRunResult = {
    totalCanonicals,
    files: feedResults,
    dryRun,
    durationMs: Date.now() - startedAt,
  };

  logger.info(
    { totalCanonicals, durationMs: result.durationMs },
    "Meta export complete",
  );

  return result;
}
