/**
 * Google Feed Runner
 *
 * Orchestrates the full Google export cycle:
 *   1. Read canonical products from DB
 *   2. Map to Google payloads
 *   3. Generate TSV snapshots → App Storage
 *   4. Atomic publish (item-count gate)
 *   5. Upsert to Merchant Center API (if not dry-run)
 *   6. Sync local inventory (Eupen showroom)
 *   7. Record feed_snapshots in DB
 *
 * Run via: pnpm sync:google
 * Env: GOOGLE_DRY_RUN=false to actually push to Merchant Center.
 */

import { db, feedSnapshotsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { loadConfig } from "../../config/loader";
import { logger as rootLogger } from "../../lib/logger";
import {
  uploadFeedFile,
  uploadManifest,
  atomicPublish,
  downloadManifest,
  googleFeedPath,
  versionedPath,
  formatVersionTs,
  type FeedManifest,
} from "../../lib/storage";
import { readAllCanonicals } from "../canonical-reader";
import {
  mapToGoogleRow,
  mapToGoogleResource,
  buildGoogleTsv,
  type GoogleFeedRow,
} from "./mapper";
import { batchUpsertProducts, isDryRun } from "./client";
import { syncLocalInventory } from "./local-inventory";
import { validateGoogleFeed } from "../../validation/feed-validator";
import type { CanonicalProduct } from "../../canonical/types";

const logger = rootLogger.child({ module: "google-runner" });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GoogleRunResult {
  markets: string[];
  totalCanonicals: number;
  byMarket: Record<
    string,
    {
      language: string;
      country: string;
      rows: number;
      storagePath: string;
      published: boolean;
      upserted: number;
      failed: number;
    }
  >;
  localInventory: { submitted: number; failed: number };
  dryRun: boolean;
  durationMs: number;
}

// ── Per-market feed generation ─────────────────────────────────────────────────

interface MarketFeedSpec {
  marketCode: string;
  language: string;
  country: string;
  canonicals: CanonicalProduct[];
}

async function generateMarketFeed(
  spec: MarketFeedSpec,
  versionTs: string,
  runId: string | null,
  syncRunId: string | null,
): Promise<{
  storagePath: string;
  itemCount: number;
  sha256: string;
  published: boolean;
}> {
  const { marketCode, language, country, canonicals } = spec;

  // Filter and map
  const rows: GoogleFeedRow[] = [];
  const resources = [];
  for (const c of canonicals) {
    // Load config to use in mapper
  }

  // This is computed in the runner — rows and resources are passed in
  // (see runGoogleExport for actual usage)
  throw new Error("Use runGoogleExport directly");
}

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runGoogleExport(options: {
  markets?: string[];
  syncRunId?: string;
}): Promise<GoogleRunResult> {
  const startedAt = Date.now();
  const config = await loadConfig();
  const versionTs = formatVersionTs();
  const dryRun = isDryRun();

  logger.info({ dryRun, markets: options.markets ?? "all" }, "Google export starting");

  // ── 1. Read canonicals ─────────────────────────────────────────────────────
  const { canonicals, eligible, ineligible, excluded } = await readAllCanonicals(config, {
    markets: options.markets,
    channel: "google",
    persistFeedItems: true,
  });

  logger.info({ eligible, ineligible, excluded }, "Canonicals loaded");

  // Group by market
  const byMarket = new Map<string, CanonicalProduct[]>();
  for (const c of canonicals) {
    const list = byMarket.get(c.market) ?? [];
    list.push(c);
    byMarket.set(c.market, list);
  }

  const result: GoogleRunResult = {
    markets: [...byMarket.keys()],
    totalCanonicals: canonicals.length,
    byMarket: {},
    localInventory: { submitted: 0, failed: 0 },
    dryRun,
    durationMs: 0,
  };

  // ── 2. Process each market ─────────────────────────────────────────────────
  for (const [marketCode, marketCanonicals] of byMarket) {
    const market = config.markets.markets[marketCode];
    if (!market) continue;
    const language = market.language;
    const country = market.country;

    logger.info({ marketCode, language, country, count: marketCanonicals.length }, "Processing market");

    // Map to rows (skip products with no image)
    const rows: GoogleFeedRow[] = [];
    const resources = [];
    for (const canonical of marketCanonicals) {
      const row = mapToGoogleRow(canonical, config);
      if (row) rows.push(row);
      const resource = mapToGoogleResource(canonical, config);
      if (resource) resources.push(resource);
    }

    const currentPath = googleFeedPath(language, marketCode);
    const versioned = versionedPath(currentPath, versionTs);

    // ── 3. Generate TSV and upload to versioned path ────────────────────────
    const tsv = buildGoogleTsv(rows);
    const sha256 = await uploadFeedFile(versioned, tsv, "text/tab-separated-values");

    const manifest: FeedManifest = {
      version: versionTs,
      generatedAt: new Date().toISOString(),
      itemCount: rows.length,
      sha256,
      sourceRunId: options.syncRunId ?? null,
      channel: "google",
      language,
      marketCode,
    };
    await uploadManifest(versioned, manifest);

    // ── 4. Fetch previous snapshot count for gate ───────────────────────────
    let previousItemCount: number | null = null;
    const prevManifest = await downloadManifest(currentPath).catch(() => null);
    if (prevManifest) previousItemCount = prevManifest.itemCount;

    // ── 5. Validation gate ─────────────────────────────────────────────────
    const { snapshot_gate } = config.feedPolicy;
    let schemaValid = true;
    if (snapshot_gate.require_zero_schema_errors) {
      const validation = await validateGoogleFeed(versioned);
      schemaValid = validation.valid;
      if (!schemaValid) {
        logger.error(
          { marketCode, errors: validation.errorCount, firstError: validation.errors[0] },
          "Google feed schema validation FAILED — blocking publish",
        );
      } else {
        logger.info({ marketCode, rows: validation.rowCount }, "Google feed schema validation passed");
      }
    }

    // ── 6. Atomic publish ───────────────────────────────────────────────────
    const published = schemaValid
      ? await atomicPublish({
          versionedPath: versioned,
          currentPath,
          manifest,
          previousItemCount,
          maxDropPct: snapshot_gate.max_item_count_drop_pct,
        })
      : false;

    // ── 6. Upsert to Merchant API ───────────────────────────────────────────
    let upserted = 0;
    let failed = 0;

    if (published || dryRun) {
      const { succeeded, failed: f } = await batchUpsertProducts(resources);
      upserted = succeeded;
      failed = f;
    }

    // ── 7. Record feed snapshot ─────────────────────────────────────────────
    if (published) {
      // Mark all previous snapshots for this market/language as not current
      await db
        .update(feedSnapshotsTable)
        .set({ isCurrent: false })
        .where(
          and(
            eq(feedSnapshotsTable.channel, "google"),
            eq(feedSnapshotsTable.language, language),
            eq(feedSnapshotsTable.marketCode, marketCode),
          ),
        );

      await db.insert(feedSnapshotsTable).values({
        channel: "google",
        language,
        marketCode,
        storagePath: currentPath,
        itemCount: rows.length,
        sha256,
        isCurrent: true,
        syncRunId: options.syncRunId ?? null,
        generatedAt: new Date(),
      });
    }

    result.byMarket[marketCode] = {
      language,
      country,
      rows: rows.length,
      storagePath: published ? currentPath : versioned,
      published,
      upserted,
      failed,
    };

    logger.info(
      { marketCode, rows: rows.length, published, upserted, failed },
      "Market feed complete",
    );
  }

  // ── 8. Sync local inventory (Eupen showroom) ──────────────────────────────
  //
  // Only Belgium market products have Eupen showroom relevance.
  // BE_FR → country=BE, language=fr
  // BE_DE → country=BE, language=de
  //
  // Deduplicate by variantId: a variant appearing in both BE_FR and BE_DE
  // must only be submitted once per language to avoid duplicate/wrong-country
  // offer IDs in Merchant Inventories.
  const beCanonicalsByLang = new Map<string, Map<string, CanonicalProduct>>();
  for (const c of canonicals) {
    if (c.market !== "BE_FR" && c.market !== "BE_DE") continue;
    const lang = c.language;
    if (!beCanonicalsByLang.has(lang)) beCanonicalsByLang.set(lang, new Map());
    // last-write wins if same variantId appears in both BE_FR and BE_DE for same lang
    beCanonicalsByLang.get(lang)!.set(c.variantId, c);
  }

  for (const [lang, variantMap] of beCanonicalsByLang) {
    const beSlice = [...variantMap.values()];
    const invResult = await syncLocalInventory(beSlice, "BE", lang);
    result.localInventory.submitted += invResult.submitted;
    result.localInventory.failed += invResult.failed;
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(
    { totalCanonicals: canonicals.length, markets: result.markets.length, durationMs: result.durationMs },
    "Google export complete",
  );

  return result;
}
