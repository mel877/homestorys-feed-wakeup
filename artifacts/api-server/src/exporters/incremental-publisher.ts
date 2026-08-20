/**
 * Incremental URL feed publisher.
 *
 * Shopify webhooks rehydrate only the product that changed. Its canonical feed
 * rows are replaced in feed_items, then the stable public language URLs are
 * rebuilt from that cached canonical state. The public files must stay complete:
 * Google and Meta interpret an omitted row as a deletion.
 *
 * The nightly full export remains the reconciliation path for missed webhooks.
 */
import {
  db,
  feedItemsTable,
  feedSnapshotsTable,
  variantsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CanonicalProduct } from "../canonical/types";
import { loadConfig } from "../config/loader";
import { logger as rootLogger } from "../lib/logger";
import {
  atomicPublish,
  downloadFeedFile,
  downloadManifest,
  formatVersionTs,
  googleLanguageFeedPath,
  metaLanguageFeedPath,
  uploadFeedFile,
  uploadManifest,
  versionedPath,
  type FeedManifest,
} from "../lib/storage";
import { createHash } from "crypto";
import { resolveGoogleDryRun, resolveMetaDryRun } from "./dry-run";
import { withExportLock } from "./export-lock";
import { processAllCanonicals } from "./canonical-reader";
import { buildGoogleTsv, mapToGoogleRow } from "./google/mapper";
import { mapToMeta } from "./meta/mapper";
import { serializeMetaLanguageRows } from "./meta/language-feeds";
import { validateGoogleFeed, validateMetaFeed } from "../validation/feed-validator";

const logger = rootLogger.child({ module: "incremental-feed-publisher" });

type Channel = "google" | "meta";

/**
 * Raised when a Shopify delta cannot be reflected in every affected public
 * catalog. The webhook worker keeps this event retryable.
 */
export class IncrementalFeedPublicationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncrementalFeedPublicationBlockedError";
  }
}

interface CachedFeedItem {
  marketCode: string;
  language: string;
  channel: string;
  canonicalJson: Record<string, unknown> | null;
}

async function replaceCachedRows(productIds: string[]) {
  const variants = await db
    .select({ id: variantsTable.id })
    .from(variantsTable)
    .where(inArray(variantsTable.productId, productIds));
  const variantIds = variants.map((variant) => variant.id);
  if (variantIds.length === 0) return { before: [] as CachedFeedItem[], variantIds };

  const before = await db
    .select({
      marketCode: feedItemsTable.marketCode,
      language: feedItemsTable.language,
      channel: feedItemsTable.channel,
      canonicalJson: feedItemsTable.canonicalJson,
    })
    .from(feedItemsTable)
    .where(inArray(feedItemsTable.variantId, variantIds));

  await db.delete(feedItemsTable).where(inArray(feedItemsTable.variantId, variantIds));

  const config = loadConfig();
  for (const channel of ["google", "meta"] as const) {
    await processAllCanonicals(
      config,
      { channel, productIds, persistFeedItems: true },
      () => undefined,
    );
  }

  return { before, variantIds };
}

async function currentChangedRows(variantIds: string[]): Promise<CachedFeedItem[]> {
  if (variantIds.length === 0) return [];
  const rows = await db
    .select({
      marketCode: feedItemsTable.marketCode,
      language: feedItemsTable.language,
      channel: feedItemsTable.channel,
      canonicalJson: feedItemsTable.canonicalJson,
    })
    .from(feedItemsTable)
    .where(inArray(feedItemsTable.variantId, variantIds));
  return rows.map((row) => ({
    ...row,
    canonicalJson: row.canonicalJson as Record<string, unknown> | null,
  }));
}

async function cachedCanonicals(channel: Channel, markets: string[]): Promise<CanonicalProduct[]> {
  if (markets.length === 0) return [];
  const rows = await db
    .select({ canonicalJson: feedItemsTable.canonicalJson })
    .from(feedItemsTable)
    .where(and(
      eq(feedItemsTable.channel, channel),
      eq(feedItemsTable.isEligible, true),
      inArray(feedItemsTable.marketCode, markets),
    ));
  return rows.flatMap((row) => row.canonicalJson ? [row.canonicalJson as unknown as CanonicalProduct] : []);
}

async function hasCurrentSnapshot(channel: Channel, language: string): Promise<boolean> {
  const current = await db
    .select({ id: feedSnapshotsTable.id })
    .from(feedSnapshotsTable)
    .where(and(
      eq(feedSnapshotsTable.channel, channel),
      eq(feedSnapshotsTable.language, language),
      eq(feedSnapshotsTable.marketCode, `LANG_${language.toUpperCase()}`),
      eq(feedSnapshotsTable.isCurrent, true),
    ))
    .limit(1);
  return current.length > 0;
}

async function serializeCachedLanguage(channel: Channel, language: string): Promise<{ content: string; itemCount: number }> {
  const config = loadConfig();
  const markets = config.markets.language_masters[language]?.markets ?? [];
  const canonicals = await cachedCanonicals(channel, markets);
  if (channel === "google") {
    const rows = canonicals.flatMap((canonical) => {
      const row = mapToGoogleRow(canonical, config);
      return row ? [row] : [];
    });
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return { content: buildGoogleTsv(rows), itemCount: rows.length };
  }
  const rows = canonicals.flatMap((canonical) => {
    const mapped = mapToMeta(canonical, config);
    if (!mapped) return [];
    return [{
      ...mapped.base,
      ...Object.fromEntries(Object.entries(mapped.language_row).filter(([key]) => key !== "id")),
      ...Object.fromEntries(Object.entries(mapped.country_row).filter(([key]) => key !== "id")),
    }];
  });
  const { csv, itemCount } = serializeMetaLanguageRows(rows);
  return { content: csv, itemCount };
}

/**
 * A delta run is allowed only when feed_items can reproduce the currently
 * published URL exactly. If the cache was introduced after a feed was published,
 * or was interrupted part-way through an earlier event, reconcile with the full
 * exporter instead of risking a partial public catalog.
 */
async function cacheMatchesCurrentSnapshot(channel: Channel, language: string): Promise<boolean> {
  const snapshot = await db
    .select({ itemCount: feedSnapshotsTable.itemCount })
    .from(feedSnapshotsTable)
    .where(and(
      eq(feedSnapshotsTable.channel, channel),
      eq(feedSnapshotsTable.language, language),
      eq(feedSnapshotsTable.marketCode, `LANG_${language.toUpperCase()}`),
      eq(feedSnapshotsTable.isCurrent, true),
    ))
    .limit(1);
  if (!snapshot[0]) return false;

  const currentPath = channel === "google"
    ? googleLanguageFeedPath(language)
    : metaLanguageFeedPath(language);
  const manifest = await downloadManifest(currentPath).catch(() => null);
  if (!manifest || manifest.itemCount !== snapshot[0].itemCount) return false;

  const currentFile = await downloadFeedFile(currentPath);
  if (!currentFile) return false;
  const currentHash = createHash("sha256").update(currentFile).digest("hex");
  if (currentHash !== manifest.sha256) return false;

  const cached = await serializeCachedLanguage(channel, language);
  const cachedHash = createHash("sha256").update(cached.content).digest("hex");
  return cached.itemCount === snapshot[0].itemCount && cachedHash === manifest.sha256;
}

async function bootstrapCompleteCacheIfNeeded(): Promise<boolean> {
  const complete = await Promise.all(
    (["google", "meta"] as const).flatMap((channel) =>
      ["fr", "de"].map((language) => cacheMatchesCurrentSnapshot(channel, language)),
    ),
  );
  if (complete.every(Boolean)) return false;

  logger.warn("Incremental cache is not proven complete; running safe full reconciliation");
  // Full exports are authoritative for active products, but only upsert their
  // current rows. Clearing first removes rows left by missed deletions.
  await db.delete(feedItemsTable).where(sql`true`);
  const [{ runGoogleExport }, { runMetaExport }] = await Promise.all([
    import("./google/runner"),
    import("./meta/generator"),
  ]);
  await runGoogleExport({ skipGoogleApi: true });
  await runMetaExport({});

  const config = loadConfig();
  // Meta's public language export intentionally avoids persisting feed_items
  // while it writes its flat URLs. Rebuild the Meta cache explicitly so the
  // parity check below can prove both channels are complete.
  await processAllCanonicals(
    config,
    { channel: "meta", persistFeedItems: true },
    () => undefined,
  );
  const checks = await Promise.all(
    (["google", "meta"] as const).flatMap((channel) =>
      ["fr", "de"].map(async (language) => ({
        channel,
        language,
        matches: await cacheMatchesCurrentSnapshot(channel, language),
      })),
    ),
  );
  // A dry-run deliberately keeps the public URL unchanged. It is not an
  // export failure, but it must not be mistaken for a successful publication.
  const mustBePublished = checks.filter(({ channel }) =>
    channel === "google" ? !resolveGoogleDryRun(config) : !resolveMetaDryRun(config),
  );
  const failed = mustBePublished.filter(({ matches }) => !matches);
  if (failed.length > 0) {
    throw new IncrementalFeedPublicationBlockedError(
      `Full URL-feed reconciliation did not produce verifiable current snapshots: ${failed
        .map(({ channel, language }) => `${channel}/${language}`)
        .join(", ")}`,
    );
  }
  return true;
}

async function recordSnapshot(params: {
  channel: Channel;
  language: string;
  storagePath: string;
  itemCount: number;
  sha256: string;
}): Promise<void> {
  const marketCode = `LANG_${params.language.toUpperCase()}`;
  await db.update(feedSnapshotsTable).set({ isCurrent: false }).where(and(
    eq(feedSnapshotsTable.channel, params.channel),
    eq(feedSnapshotsTable.language, params.language),
    eq(feedSnapshotsTable.marketCode, marketCode),
  ));
  await db.insert(feedSnapshotsTable).values({
    channel: params.channel,
    language: params.language,
    marketCode,
    storagePath: params.storagePath,
    itemCount: params.itemCount,
    sha256: params.sha256,
    isCurrent: true,
    generatedAt: new Date(),
  });
}

async function publishGoogleLanguage(language: string): Promise<boolean> {
  const config = loadConfig();
  if (resolveGoogleDryRun(config)) return true;
  if (!(await hasCurrentSnapshot("google", language))) return false;
  const markets = config.markets.language_masters[language]?.markets ?? [];
  const rows = (await cachedCanonicals("google", markets))
    .flatMap((canonical) => {
      const row = mapToGoogleRow(canonical, config);
      return row ? [row] : [];
    });
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const currentPath = googleLanguageFeedPath(language);
  const version = formatVersionTs();
  const versioned = versionedPath(currentPath, version);
  const sha256 = await uploadFeedFile(versioned, buildGoogleTsv(rows), "text/tab-separated-values");
  const manifest: FeedManifest = {
    version,
    generatedAt: new Date().toISOString(),
    itemCount: rows.length,
    sha256,
    sourceRunId: null,
    channel: "google",
    language,
    marketCode: `LANG_${language.toUpperCase()}`,
  };
  await uploadManifest(versioned, manifest);
  const validation = await validateGoogleFeed(versioned);
  const previousItemCount = (await downloadManifest(currentPath))?.itemCount ?? null;
  if (!validation.valid) {
    logger.error({ language, errors: validation.errorCount }, "Incremental Google feed validation failed; retaining current feed");
    return false;
  }
  const published = await atomicPublish({
    versionedPath: versioned,
    currentPath,
    manifest,
    previousItemCount,
    maxDropPct: config.feedPolicy.snapshot_gate.max_item_count_drop_pct,
  });
  if (published) await recordSnapshot({ channel: "google", language, storagePath: currentPath, itemCount: rows.length, sha256 });
  return published;
}

async function publishMetaLanguage(language: string): Promise<boolean> {
  const config = loadConfig();
  if (resolveMetaDryRun(config)) return true;
  if (!(await hasCurrentSnapshot("meta", language))) return false;
  const markets = config.markets.language_masters[language]?.markets ?? [];
  const rows = (await cachedCanonicals("meta", markets))
    .flatMap((canonical) => {
      const mapped = mapToMeta(canonical, config);
      if (!mapped) return [];
      return [{
        ...mapped.base,
        ...Object.fromEntries(Object.entries(mapped.language_row).filter(([key]) => key !== "id")),
        ...Object.fromEntries(Object.entries(mapped.country_row).filter(([key]) => key !== "id")),
      }];
    });
  const { csv, itemCount } = serializeMetaLanguageRows(rows);
  const currentPath = metaLanguageFeedPath(language);
  const version = formatVersionTs();
  const versioned = versionedPath(currentPath, version);
  const sha256 = await uploadFeedFile(versioned, csv, "text/csv");
  const manifest: FeedManifest = {
    version,
    generatedAt: new Date().toISOString(),
    itemCount,
    sha256,
    sourceRunId: null,
    channel: "meta",
    language,
    marketCode: `LANG_${language.toUpperCase()}`,
  };
  await uploadManifest(versioned, manifest);
  const validation = await validateMetaFeed(versioned);
  const previousItemCount = (await downloadManifest(currentPath))?.itemCount ?? null;
  if (!validation.valid) {
    logger.error({ language, errors: validation.errorCount }, "Incremental Meta feed validation failed; retaining current feed");
    return false;
  }
  const published = await atomicPublish({
    versionedPath: versioned,
    currentPath,
    manifest,
    previousItemCount,
    maxDropPct: config.feedPolicy.snapshot_gate.max_item_count_drop_pct,
  });
  if (published) await recordSnapshot({ channel: "meta", language, storagePath: currentPath, itemCount, sha256 });
  return published;
}

/**
 * Refresh only the cache rows for changed products, then atomically refresh the
 * affected stable Google/Meta language URLs from that cache.
 */
export async function publishProductChanges(productIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(productIds)];
  if (uniqueIds.length === 0) return;
  await withExportLock(async () => {
    // Never derive a public URL from a cache that has not first been proven to
    // match a complete, atomically published snapshot.
    if (await bootstrapCompleteCacheIfNeeded()) return;

    const { before, variantIds } = await replaceCachedRows(uniqueIds);
    const after = await currentChangedRows(variantIds);
    const byChannelLanguage = new Map<Channel, Set<string>>([
      // Rebuild both stable language URLs. This makes delete/retry recovery
      // deterministic even if a prior attempt was interrupted after deleting
      // a product's cache rows.
      ["google", new Set(["fr", "de"])],
      ["meta", new Set(["fr", "de"])],
    ]);
    for (const row of [...before, ...after]) {
      if ((row.channel === "google" || row.channel === "meta") && (row.language === "fr" || row.language === "de")) {
        byChannelLanguage.get(row.channel)?.add(row.language);
      }
    }
    const published = await Promise.all([
      ...[...byChannelLanguage.get("google")!].map(publishGoogleLanguage),
      ...[...byChannelLanguage.get("meta")!].map(publishMetaLanguage),
    ]);
    if (!published.every(Boolean)) {
      throw new IncrementalFeedPublicationBlockedError(
        "One or more incremental public URL feeds were blocked; retaining webhook for retry",
      );
    }
    logger.info(
      { products: uniqueIds.length, googleLanguages: [...byChannelLanguage.get("google")!], metaLanguages: [...byChannelLanguage.get("meta")!] },
      "Incremental URL feeds refreshed",
    );
  });
}