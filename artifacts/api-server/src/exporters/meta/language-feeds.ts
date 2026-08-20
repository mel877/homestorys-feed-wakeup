import { stringify } from "csv-stringify/sync";
import { stringify as stringifyStream } from "csv-stringify";
import { once } from "node:events";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, feedItemsTable, feedSnapshotsTable } from "@workspace/db";
import type { AppConfig } from "../../config/schemas";
import { logger as rootLogger } from "../../lib/logger";
import {
  atomicPublish,
  createFeedFileWriteStream,
  downloadManifest,
  formatVersionTs,
  metaLanguageFeedPath,
  uploadManifest,
  versionedPath,
  type FeedManifest,
} from "../../lib/storage";
import {
  createMetaRowValidator,
  type FeedValidationResult,
  type ValidationError,
} from "../../validation/feed-validator";
import {
  mapToMeta,
  META_BASE_HEADERS,
  META_COUNTRY_HEADERS,
  META_LANGUAGE_HEADERS,
} from "./mapper";

const logger = rootLogger.child({ module: "meta-language-feeds" });

export const META_LANGUAGE_FEED_HEADERS = [
  ...META_BASE_HEADERS,
  ...META_LANGUAGE_HEADERS.filter((header) => header !== "id"),
  ...META_COUNTRY_HEADERS.filter((header) => header !== "id"),
] as string[];

/**
 * The public Meta language URL is a flat, market-aware file. Keep its byte
 * order deterministic so a cached re-serialization can prove it matches the
 * current snapshot before an incremental publish is allowed.
 */
export function serializeMetaLanguageRows(rows: Record<string, string>[]): {
  csv: string;
  itemCount: number;
} {
  const ordered = [...rows].sort((a, b) =>
    META_LANGUAGE_FEED_HEADERS
      .map((header) => String(a[header] ?? ""))
      .join("\u001f")
      .localeCompare(
        META_LANGUAGE_FEED_HEADERS
          .map((header) => String(b[header] ?? ""))
          .join("\u001f"),
      ),
  );
  return {
    csv: stringify(ordered, { header: true, columns: META_LANGUAGE_FEED_HEADERS }),
    itemCount: ordered.length,
  };
}

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
  options: { syncRunId?: string; dryRun: boolean; languages?: Array<"fr" | "de"> },
): Promise<Record<string, MetaLanguageFeedResult>> {
  const results: Record<string, MetaLanguageFeedResult> = {};
  const version = formatVersionTs();

  for (const language of options.languages ?? ["fr", "de"]) {
    const markets = config.markets.language_masters[language]?.markets ?? [];
    const currentPath = metaLanguageFeedPath(language);
    const versioned = versionedPath(currentPath, version);

    try {
      const upload = createFeedFileWriteStream(versioned, "text/csv");
      const stringifier = stringifyStream();
      stringifier.pipe(upload.stream);
      stringifier.write(META_LANGUAGE_FEED_HEADERS);

      const validateRow = config.feedPolicy.snapshot_gate.require_zero_schema_errors
        ? createMetaRowValidator("meta-product")
        : null;
      let validationRowCount = 0;
      let validationErrorCount = 0;
      const validationErrors: ValidationError[] = [];
      let itemCount = 0;
      let offset = 0;
      const pageSize = 250;

      while (true) {
        const items = await db
          .select({ canonicalJson: feedItemsTable.canonicalJson })
          .from(feedItemsTable)
          .where(and(
            eq(feedItemsTable.channel, "meta"),
            eq(feedItemsTable.language, language),
            inArray(feedItemsTable.marketCode, markets),
          ))
          .orderBy(asc(feedItemsTable.variantId), asc(feedItemsTable.marketCode))
          .limit(pageSize)
          .offset(offset);
        if (items.length === 0) break;

        for (const item of items) {
          const mapped = mapToMeta(item.canonicalJson as Parameters<typeof mapToMeta>[0], config);
          if (!mapped) continue;
          const row: Record<string, string> = {
            ...mapped.base,
            ...Object.fromEntries(Object.entries(mapped.language_row).filter(([key]) => key !== "id")),
            ...Object.fromEntries(Object.entries(mapped.country_row).filter(([key]) => key !== "id")),
          };
          itemCount++;
          validationRowCount++;
          if (validateRow) {
            const errors = validateRow(row, validationRowCount + 1);
            validationErrorCount += errors.length;
            if (validationErrors.length < 200) {
              validationErrors.push(...errors.slice(0, 200 - validationErrors.length));
            }
          }
          const record = META_LANGUAGE_FEED_HEADERS.map((header) => row[header] ?? "");
          if (!stringifier.write(record)) {
            await once(stringifier, "drain");
          }
        }
        offset += items.length;
      }

      stringifier.end();
      const { sha256 } = await upload.done;
      const manifest: FeedManifest = {
        version,
        generatedAt: new Date().toISOString(),
        itemCount,
        sha256,
        sourceRunId: options.syncRunId ?? null,
        channel: "meta",
        language,
        marketCode: `LANG_${language.toUpperCase()}`,
      };
      await uploadManifest(versioned, manifest);

      const previousItemCount = (await downloadManifest(currentPath))?.itemCount ?? null;
      const validation: FeedValidationResult = {
        file: versioned,
        rowCount: validationRowCount,
        errorCount: validationErrorCount,
        errors: validationErrors,
        valid: validationErrorCount === 0,
        schema: "meta-product",
      };
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
          itemCount,
          sha256,
          isCurrent: true,
          syncRunId: options.syncRunId ?? null,
          generatedAt: new Date(),
        });
      }
      results[language] = {
        rows: itemCount,
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