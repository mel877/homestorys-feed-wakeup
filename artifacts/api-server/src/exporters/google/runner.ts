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
import { processAllCanonicals } from "../canonical-reader";
import {
  mapToGoogleRow,
  buildGoogleTsv,
  type GoogleFeedRow,
} from "./mapper";
import { isDryRun } from "./client";
import { submitLocalInventoryEntries, type LocalInventoryEntry } from "./local-inventory";
import { validateGoogleFeed } from "../../validation/feed-validator";

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
      publicUrl: string;
    }
  >;
  localInventory: { submitted: number; failed: number };
  dryRun: boolean;
  durationMs: number;
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
  const { snapshot_gate } = config.feedPolicy;
  const storeCode = process.env["GOOGLE_EUPEN_STORE_CODE"] ?? "";

  logger.info({ dryRun, markets: options.markets ?? "all" }, "Google export starting");

  const targetMarkets = options.markets ?? Object.keys(config.markets.markets);

  const result: GoogleRunResult = {
    markets: targetMarkets,
    totalCanonicals: 0,
    byMarket: {},
    localInventory: { submitted: 0, failed: 0 },
    dryRun,
    durationMs: 0,
  };

  // Accumulate Belgium showroom entries across BE_FR/BE_DE to deduplicate by variantId+language
  const beInventoryByKey = new Map<string, LocalInventoryEntry>();

  // ── Process ONE market at a time ──────────────────────────────────────────
  //
  // Loading all markets simultaneously would hold 191k+ GoogleFeedRow objects in RAM
  // (~500MB+). By processing one market at a time, peak memory stays at:
  //   raw data Maps (~200MB) + one market's rows (~60MB) ≈ 260MB.
  //
  // Trade-off: the DB bulk queries run once per market (5×) instead of once total.
  // This costs a few seconds of extra query time but is well worth the memory saving.
  for (const marketCode of targetMarkets) {
    const market = config.markets.markets[marketCode];
    if (!market) continue;
    const { language, country } = market;

    logger.info({ marketCode, language, country }, "Google: streaming market canonicals");

    const rows: GoogleFeedRow[] = [];

    const { eligible, ineligible, excluded } = await processAllCanonicals(
      config,
      {
        markets: [marketCode],
        channel: "google",
        // Persist feed_items only on the first full-catalog pass to avoid
        // 5× upserts for the same canonical data. Markets are independent
        // so the first persisted value is valid for all channels.
        persistFeedItems: true,
      },
      (canonical) => {
        result.totalCanonicals++;
        const row = mapToGoogleRow(canonical, config);
        if (row) rows.push(row);

        // Eupen showroom local inventory: Belgium only, deduplicated by variantId+language
        if (
          (canonical.market === "BE_FR" || canonical.market === "BE_DE") &&
          canonical.pickupEupen &&
          (canonical.stockEupen ?? 0) > 0
        ) {
          const key = `${canonical.variantId}:${canonical.language}`;
          if (!beInventoryByKey.has(key)) {
            beInventoryByKey.set(key, {
              offerId: `online:${canonical.language}:BE:${canonical.variantId}`,
              storeCode,
              quantity: canonical.stockEupen ?? 0,
              availability: "in stock",
              pickup: "multi-day",
            });
          }
        }
      },
    );

    logger.info({ marketCode, rows: rows.length, eligible, ineligible, excluded }, "Market streamed");

    // ── Generate TSV → upload → validate → publish ─────────────────────────
    const currentPath = googleFeedPath(language, marketCode);
    const versioned = versionedPath(currentPath, versionTs);

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

    let previousItemCount: number | null = null;
    const prevManifest = await downloadManifest(currentPath).catch(() => null);
    if (prevManifest) previousItemCount = prevManifest.itemCount;

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

    const published = (!dryRun && schemaValid)
      ? await atomicPublish({
          versionedPath: versioned,
          currentPath,
          manifest,
          previousItemCount,
          maxDropPct: snapshot_gate.max_item_count_drop_pct,
        })
      : false;

    if (dryRun) {
      logger.info({ marketCode, rows: rows.length, dryRun: true }, "DRY RUN: TSV generated (not published)");
    }

    if (published) {
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
      published: published || dryRun,
      publicUrl: `/api/feeds/google/market/${marketCode}.tsv`,
    };

    logger.info({ marketCode, rows: rows.length, published }, "Market feed complete");
    // rows[] goes out of scope here → V8 can reclaim the memory before the next market
  }

  // ── Sync local inventory (Eupen showroom) ─────────────────────────────────
  if (beInventoryByKey.size > 0) {
    const invResult = await submitLocalInventoryEntries([...beInventoryByKey.values()]);
    result.localInventory.submitted += invResult.submitted;
    result.localInventory.failed += invResult.failed;
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(
    { totalCanonicals: result.totalCanonicals, markets: result.markets.length, durationMs: result.durationMs },
    "Google export complete",
  );

  return result;
}
