/**
 * Showroom Feed Runner — Eupen Store Availability Feeds
 *
 * Generates two dedicated feed files containing ONLY products that are
 * physically available in the Eupen showroom (stockEupen > 0):
 *
 *   • Google TSV → feeds/showroom/google-eupen.tsv
 *   • Meta CSV  → feeds/showroom/meta-eupen.csv  (flat, all layers merged)
 *
 * Market: BE_DE (German-speaking Belgium — the Eupen store's catchment area).
 *
 * Design notes:
 * - Two separate processAllCanonicals passes (google + meta channels) to get
 *   the correct image selection for each platform. BE_DE is a single market so
 *   the DB hit is cheap (≪ a full export).
 * - Meta showroom uses a flat CSV (no base/language/country layering) because
 *   the file is a standalone catalog, not a delta on top of a shared base.
 * - No publish gate (item-count drop check) — the showroom catalog can
 *   legitimately shrink when stock goes to zero.
 */

import { db, feedSnapshotsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { loadConfig } from "../../config/loader";
import { logger as rootLogger } from "../../lib/logger";
import {
  uploadFeedFile,
  uploadManifest,
  versionedPath,
  formatVersionTs,
  type FeedManifest,
} from "../../lib/storage";
import { processAllCanonicals } from "../canonical-reader";
import { mapToGoogleRow, buildGoogleTsv, type GoogleFeedRow } from "../google/mapper";
import { mapToMeta } from "../meta/mapper";

const logger = rootLogger.child({ module: "showroom-runner" });

// ── Constants ──────────────────────────────────────────────────────────────────

/** Only products at this market are eligible for the Eupen showroom feed. */
const SHOWROOM_MARKET = "BE_DE";

/** Object storage paths (current/public versions). */
const GOOGLE_CURRENT_PATH = "feeds/showroom/google-eupen.tsv";
const META_CURRENT_PATH   = "feeds/showroom/meta-eupen.csv";

/**
 * Flat Meta showroom columns — all three layers (base + language + country)
 * merged into a single CSV. Meta Commerce Manager can ingest this directly
 * as a self-contained catalog without needing a layered supplemental feed.
 */
const META_SHOWROOM_HEADERS = [
  "id",
  "item_group_id",
  "title",
  "description",
  "link",
  "gtin",
  "mpn",
  "brand",
  "condition",
  "image_link",
  "additional_image_link",
  "lifestyle_image_link",
  "google_product_category",
  "product_type",
  "color",
  "material",
  "age_group",
  "gender",
  "price",
  "sale_price",
  "sale_price_effective_date",
  "availability",
  "shipping",
  "return_policy_info",
  "custom_label_0",
  "custom_label_1",
  "custom_label_2",
  "custom_label_3",
  "custom_label_4",
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShowroomRunResult {
  googleRows: number;
  metaRows: number;
  googleStoragePath: string;
  metaStoragePath: string;
  published: boolean;
  durationMs: number;
}

type FlatRecord = Record<string, string>;

// ── CSV helper ────────────────────────────────────────────────────────────────

function escapeField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvFlat(headers: readonly string[], rows: FlatRecord[]): string {
  const lines: string[] = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runShowroomExport(options?: {
  syncRunId?: string;
}): Promise<ShowroomRunResult> {
  const startedAt = Date.now();
  const config = await loadConfig();
  const versionTs = formatVersionTs();

  logger.info({ market: SHOWROOM_MARKET }, "Showroom export starting");

  // ── Pass 1: Google — image selection via google channel ───────────────────
  const googleRows: GoogleFeedRow[] = [];

  await processAllCanonicals(
    config,
    {
      markets: [SHOWROOM_MARKET],
      channel: "google",
      persistFeedItems: false, // showroom is supplemental — don't overwrite feed_items
    },
    (canonical) => {
      if ((canonical.stockEupen ?? 0) <= 0) return; // showroom gate
      const row = mapToGoogleRow(canonical, config);
      if (row) {
        // The stockEupen > 0 gate above guarantees physical availability in the
        // Eupen store regardless of online stock. Override the online-derived
        // availability so Google Merchant Center sees the correct in-store status.
        row.availability = "in stock";
        row.availability_date = ""; // no backorder date for showroom stock
        googleRows.push(row);
      }
    },
  );

  logger.info({ rows: googleRows.length }, "Showroom Google pass complete");

  // ── Pass 2: Meta — image selection via meta channel ───────────────────────
  const metaFlatRows: FlatRecord[] = [];

  await processAllCanonicals(
    config,
    {
      markets: [SHOWROOM_MARKET],
      channel: "meta",
      persistFeedItems: false,
    },
    (canonical) => {
      if ((canonical.stockEupen ?? 0) <= 0) return; // showroom gate
      const mapped = mapToMeta(canonical, config);
      if (!mapped) return;

      // Merge all three layers into a single flat row
      const flat: FlatRecord = {
        // Base fields
        id:                      mapped.base.id,
        item_group_id:           mapped.base.item_group_id,
        gtin:                    mapped.base.gtin,
        mpn:                     mapped.base.mpn,
        brand:                   mapped.base.brand,
        condition:               mapped.base.condition,
        image_link:              mapped.base.image_link,
        additional_image_link:   mapped.base.additional_image_link,
        lifestyle_image_link:    mapped.base.lifestyle_image_link,
        google_product_category: mapped.base.google_product_category,
        product_type:            mapped.base.product_type,
        color:                   mapped.base.color,
        material:                mapped.base.material,
        age_group:               mapped.base.age_group,
        gender:                  mapped.base.gender,
        return_policy_info:      mapped.base.return_policy_info,
        custom_label_0:          mapped.base.custom_label_0,
        custom_label_1:          mapped.base.custom_label_1,
        custom_label_2:          mapped.base.custom_label_2,
        custom_label_3:          mapped.base.custom_label_3,
        custom_label_4:          mapped.base.custom_label_4,
        // Language fields (DE for Eupen)
        title:                   mapped.language_row.title,
        description:             mapped.language_row.description,
        link:                    mapped.language_row.link,
        // Country fields (BE) — availability overridden: stockEupen > 0 gate
        // above guarantees physical availability regardless of online stock.
        price:                   mapped.country_row.price,
        sale_price:              mapped.country_row.sale_price,
        sale_price_effective_date: mapped.country_row.sale_price_effective_date,
        availability:            "in stock", // Meta catalogue format (space, not underscore)
        shipping:                mapped.country_row.shipping,
      };
      metaFlatRows.push(flat);
    },
  );

  logger.info({ rows: metaFlatRows.length }, "Showroom Meta pass complete");

  // ── Upload Google TSV ─────────────────────────────────────────────────────
  const googleVersioned = versionedPath(GOOGLE_CURRENT_PATH, versionTs);
  const googleTsv = buildGoogleTsv(googleRows);
  const googleSha256 = await uploadFeedFile(
    googleVersioned,
    googleTsv,
    "text/tab-separated-values",
  );

  const googleManifest: FeedManifest = {
    version: versionTs,
    generatedAt: new Date().toISOString(),
    itemCount: googleRows.length,
    sha256: googleSha256,
    sourceRunId: options?.syncRunId ?? null,
    channel: "showroom",
    language: "de",
    marketCode: SHOWROOM_MARKET,
  };
  await uploadManifest(googleVersioned, googleManifest);

  // Publish current (copy versioned → current path)
  // No item-count gate for showroom — stock can legitimately go to zero.
  await uploadFeedFile(GOOGLE_CURRENT_PATH, googleTsv, "text/tab-separated-values");

  // ── Upload Meta CSV ───────────────────────────────────────────────────────
  const metaVersioned = versionedPath(META_CURRENT_PATH, versionTs);
  const metaCsv = toCsvFlat(META_SHOWROOM_HEADERS, metaFlatRows);
  const metaSha256 = await uploadFeedFile(
    metaVersioned,
    metaCsv,
    "text/csv",
  );

  const metaManifest: FeedManifest = {
    version: versionTs,
    generatedAt: new Date().toISOString(),
    itemCount: metaFlatRows.length,
    sha256: metaSha256,
    sourceRunId: options?.syncRunId ?? null,
    channel: "showroom",
    language: "de",
    marketCode: `${SHOWROOM_MARKET}_META`,
  };
  await uploadManifest(metaVersioned, metaManifest);
  await uploadFeedFile(META_CURRENT_PATH, metaCsv, "text/csv");

  // ── Record in feed_snapshots ───────────────────────────────────────────────
  // Clear previous showroom snapshots, then insert fresh rows.
  await db
    .update(feedSnapshotsTable)
    .set({ isCurrent: false })
    .where(eq(feedSnapshotsTable.channel, "showroom"));

  await db.insert(feedSnapshotsTable).values([
    {
      channel: "showroom",
      language: "de",
      marketCode: SHOWROOM_MARKET,
      storagePath: GOOGLE_CURRENT_PATH,
      itemCount: googleRows.length,
      sha256: googleSha256,
      isCurrent: true,
      syncRunId: options?.syncRunId ?? null,
      generatedAt: new Date(),
    },
    {
      channel: "showroom",
      language: "de",
      marketCode: `${SHOWROOM_MARKET}_META`,
      storagePath: META_CURRENT_PATH,
      itemCount: metaFlatRows.length,
      sha256: metaSha256,
      isCurrent: true,
      syncRunId: options?.syncRunId ?? null,
      generatedAt: new Date(),
    },
  ]);

  const durationMs = Date.now() - startedAt;
  logger.info(
    { googleRows: googleRows.length, metaRows: metaFlatRows.length, durationMs },
    "Showroom export complete",
  );

  return {
    googleRows: googleRows.length,
    metaRows: metaFlatRows.length,
    googleStoragePath: GOOGLE_CURRENT_PATH,
    metaStoragePath: META_CURRENT_PATH,
    published: true,
    durationMs,
  };
}
