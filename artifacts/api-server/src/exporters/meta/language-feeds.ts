import { stringify } from "csv-stringify/sync";
import { and, eq } from "drizzle-orm";
import { db, feedSnapshotsTable } from "@workspace/db";
import type { AppConfig } from "../../config/schemas";
import { logger as rootLogger } from "../../lib/logger";
import {
  atomicPublish,
  downloadManifest,
  formatVersionTs,
  metaLanguageFeedPath,
  uploadFeedFile,
  uploadManifest,
  versionedPath,
  type FeedManifest,
} from "../../lib/storage";
import { validateMetaFeed } from "../../validation/feed-validator";
import { processAllCanonicals } from "../canonical-reader";
import {
  mapToMeta,
  META_BASE_HEADERS,
  META_COUNTRY_HEADERS,
  META_LANGUAGE_HEADERS,
} from "./mapper";

const logger = rootLogger.child({ module: "meta-language-feeds" });

const META_LANGUAGE_FEED_HEADERS = [
  ...META_BASE_HEADERS,
  ...META_LANGUAGE_HEADERS.filter((header) => header !== "id"),
  ...META_COUNTRY_HEADERS.filter((header) => header !== "id"),
] as string[];

export type MetaLanguageFeedResult = {
  rows: number;
  published: boolean;
  storagePath: string;
  error?: string;
};

/**
 * Publish the two Meta URLs consumed by Commerce Manager. Each file is flat
 * and contains one row per variant + commercial market, so country-specific
 * prices, currencies and shipping remain intact inside the language feed.
 */
export async function publishMetaLanguageFeeds(
  config: AppConfig,
  options: { syncRunId?: string; dryRun: boolean },
): Promise<Record<string, MetaLanguageFeedResult>> {
  const results: Record<string, MetaLanguageFeedResult> = {};
  const version = formatVersionTs();

  for (const language of ["fr", "de"]) {
    const markets = config.markets.language_masters[language]?.markets ?? [];
    const rows: Record<string, string>[] = [];
    const currentPath = metaLanguageFeedPath(language);
    const versioned = versionedPath(currentPath, version);

    try {
      await processAllCanonicals(
        config,
        { markets, channel: "meta", persistFeedItems: false },
        (canonical) => {
          const mapped = mapToMeta(canonical, config);
          if (!mapped) return;
          rows.push({
            ...mapped.base,
            ...Object.fromEntries(
              Object.entries(mapped.language_row).filter(([key]) => key !== "id"),
            ),
            ...Object.fromEntries(
              Object.entries(mapped.country_row).filter(([key]) => key !== "id"),
            ),
          });
        },
      );

      const csv = stringify(rows, { header: true, columns: META_LANGUAGE_FEED_HEADERS });
      const sha256 = await uploadFeedFile(versioned, csv, "text/csv");
      const manifest: FeedManifest = {
        version,
        generatedAt: new Date().toISOString(),
        itemCount: rows.length,
        sha256,
        sourceRunId: options.syncRunId ?? null,
        channel: "meta",
        language,
        marketCode: `LANG_${language.toUpperCase()}`,
      };
      await uploadManifest(versioned, manifest);

      const previousItemCount = (await downloadManifest(currentPath))?.itemCount ?? null;
      const validation = await validateMetaFeed(versioned);
      const published = !options.dryRun && validation.valid
        ? await atomicPublish({
            versionedPath: versioned,
            currentPath,
            manifest,
            previousItemCount,
            maxDropPct: config.feedPolicy.snapshot_gate.max_item_count_drop_pct,
          })
        : false;

      if (published) {
        await db.update(feedSnapshotsTable).set({ isCurrent: false }).where(and(
          eq(feedSnapshotsTable.channel, "meta"),
          eq(feedSnapshotsTable.language, language),
          eq(feedSnapshotsTable.marketCode, manifest.marketCode!),
        ));
        await db.insert(feedSnapshotsTable).values({
          channel: "meta",
          language,
          marketCode: manifest.marketCode!,
          storagePath: currentPath,
          itemCount: rows.length,
          sha256,
          isCurrent: true,
          syncRunId: options.syncRunId ?? null,
          generatedAt: new Date(),
        });
      }
      results[language] = {
        rows: rows.length,
        published: published || options.dryRun,
        storagePath: published ? currentPath : versioned,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message, language }, "Meta language feed failed; existing file remains current");
      results[language] = { rows: 0, published: false, storagePath: currentPath, error: message };
    }
  }

  return results;
}