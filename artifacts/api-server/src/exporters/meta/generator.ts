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
 * Memory-efficient design:
 *   Bulk DB data is loaded ONCE (products, variants, images, inventory) and
 *   reused across all 5 market iterations. Country and language feed files are
 *   published and freed from memory as soon as their contributing markets are
 *   processed. The base file is streamed row-by-row to App Storage during the
 *   market loop (only a Set of seen ids stays in memory), so peak heap ≈ bulk
 *   data (~1GB) + one language/country buffer — well under 4 GB.
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
import { stringify as stringifyStream } from "csv-stringify";
import { once } from "events";
import {
  db,
  feedSnapshotsTable,
  productsTable,
  variantsTable,
  marketVariantsTable,
  productTranslationsTable,
  imagesTable,
  inventoryLevelsTable,
  recommendationsTable,
  feedItemsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { loadConfig } from "../../config/loader";
import type { AppConfig } from "../../config/schemas";
import { logger as rootLogger } from "../../lib/logger";
import {
  uploadFeedFile,
  createFeedFileWriteStream,
  uploadManifest,
  atomicPublish,
  downloadManifest,
  metaFeedPath,
  versionedPath,
  formatVersionTs,
  type FeedManifest,
} from "../../lib/storage";
import { sendFeedBlockAlert, resolveAlertWebhookUrl } from "../../lib/alerting";
import { buildCanonical } from "../../canonical/builder";
import type {
  ProductRow,
  VariantRow,
  MarketVariantRow,
  TranslationRow,
  ImageRow,
  InventoryRow,
  RecommendationRow,
} from "../../canonical/types";
import { computeChecksum } from "../../shopify/checksums";
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
import { publishMetaLanguageFeeds } from "./language-feeds";
import { resolveMetaDryRun } from "../dry-run";
const logger = rootLogger.child({ module: "meta-generator" });

export function isDryRun(config: AppConfig): boolean {
  return resolveMetaDryRun(config);
}

// ── Feed files to generate ────────────────────────────────────────────────────

type MetaFeedKey =
  | "base"
  | "language-fr"
  | "language-de"
  | "country-BE"
  | "country-FR"
  | "country-DE"
  | "country-AT"
  | "country-CH"
  | "country-LU";

const META_FEED_FILES: Record<MetaFeedKey, string> = {
  "base":        "meta-base.csv",
  "language-fr": "meta-language-fr.csv",
  "language-de": "meta-language-de.csv",
  "country-BE":  "meta-country-BE.csv",
  "country-FR":  "meta-country-FR.csv",
  "country-DE":  "meta-country-DE.csv",
  "country-AT":  "meta-country-AT.csv",
  "country-CH":  "meta-country-CH.csv",
  "country-LU":  "meta-country-LU.csv",
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

const UPSERT_BATCH_SIZE = 100;
export async function runMetaExport(options: {
  markets?: string[];
  syncRunId?: string;
}): Promise<MetaRunResult> {
  const startedAt = Date.now();
  const config = await loadConfig();
  const versionTs = formatVersionTs();
  const dryRun = isDryRun(config);
  const alertWebhookUrl = resolveAlertWebhookUrl(config.feedPolicy.alerts.webhook_url);

  // Determine which markets to process
  const targetMarkets = options.markets ?? Object.keys(config.markets.markets);

  // Partial-market runs must NOT publish shared layers (base + language) because
  // those layers aggregate all markets and would be incomplete for a subset run.
  // Country layers are safe to publish for any country that's fully represented
  // in the target markets.
  const isPartialRun = (options.markets?.length ?? 0) > 0;

  // Pre-compute which markets contribute to each country FROM THE FULL CONFIG,
  // not just targetMarkets. Belgium needs both BE_FR and BE_DE; a partial run
  // that only includes BE_FR must NOT publish country-BE (it would be incomplete).
  const allConfiguredMarkets = Object.keys(config.markets.markets);
  const countryToMarkets = new Map<string, string[]>();
  for (const mc of allConfiguredMarkets) {
    const country = config.markets.markets[mc]?.country;
    if (!country) continue;
    if (!countryToMarkets.has(country)) countryToMarkets.set(country, []);
    countryToMarkets.get(country)!.push(mc);
  }

  logger.info({ dryRun, markets: options.markets ?? "all" }, "Meta export starting");

  // ── Output accumulator ───────────────────────────────────────────────────────
  const feedResults: MetaRunResult["files"] = {} as MetaRunResult["files"];

  // ── publishFeed helpers ───────────────────────────────────────────────────────
  //
  // publishFeed: serializes rows in memory and uploads (small files).
  // finalizeFeed: gate + manifest + DB record for content already uploaded to
  //   the versioned path (used by the streamed base file).
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
    await finalizeFeed(key, currentPath, versioned, rows.length, sha256, feedLanguage, feedCountry);
  }

  async function finalizeFeed(
    key: MetaFeedKey,
    currentPath: string,
    versioned: string,
    itemCount: number,
    sha256: string,
    feedLanguage: string | null,
    feedCountry: string | null,
  ): Promise<void> {
    const manifest: FeedManifest = {
      version: versionTs,
      generatedAt: new Date().toISOString(),
      itemCount,
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
            newItemCount: itemCount,
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
      ? false
      : await atomicPublish({
          versionedPath: versioned,
          currentPath,
          manifest,
          previousItemCount,
          maxDropPct: snapshot_gate.max_item_count_drop_pct,
          alertWebhookUrl,
        });

    if (dryRun) {
      logger.info({ key, rows: itemCount, versioned, dryRun: true }, "DRY RUN: feed generated (not published)");
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
        itemCount,
        sha256,
        isCurrent: true,
        syncRunId: options.syncRunId ?? null,
        generatedAt: new Date(),
      });
    }

    feedResults[key] = {
      itemCount,
      storagePath: published ? currentPath : versioned,
      published: published || dryRun,
      sha256,
    };

    logger.info({ key, rows: itemCount, published }, "Meta feed file complete");
  }

  // ── 1. ONE-TIME bulk loading ──────────────────────────────────────────────────
  //
  // Previously, processAllCanonicals was called once per market (5× total),
  // loading 38k variants + 41k images + 55k inventory each time. V8 does not
  // GC those arrays between async iterations, leading to 5–8× heap pressure and
  // OOM. Loading all data ONCE eliminates that repeated allocation.
  const products = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.status, "active"));

  if (products.length === 0) {
    logger.info("No active products found");
    return { totalCanonicals: 0, files: feedResults, dryRun, durationMs: Date.now() - startedAt };
  }

  const productIds = products.map((p) => p.id);
  logger.info({ count: products.length }, "Active products loaded");

  const variants = await db
    .select()
    .from(variantsTable)
    .where(inArray(variantsTable.productId, productIds));

  const variantIds = variants.map((v) => v.id);

  // Load market_variants for ALL target markets at once
  const marketVariants = variantIds.length > 0
    ? await db
        .select()
        .from(marketVariantsTable)
        .where(
          and(
            inArray(marketVariantsTable.variantId, variantIds),
            inArray(marketVariantsTable.marketCode, targetMarkets),
          ),
        )
    : [];

  const translations = await db
    .select()
    .from(productTranslationsTable)
    .where(inArray(productTranslationsTable.productId, productIds));

  const images = await db
    .select()
    .from(imagesTable)
    .where(inArray(imagesTable.productId, productIds));

  const inventory = variantIds.length > 0
    ? await db
        .select()
        .from(inventoryLevelsTable)
        .where(inArray(inventoryLevelsTable.variantId, variantIds))
    : [];

  const recommendations = productIds.length > 0
    ? await db
        .select()
        .from(recommendationsTable)
        .where(inArray(recommendationsTable.productId, productIds))
    : [];

  logger.info(
    { products: products.length, variants: variants.length, marketVariants: marketVariants.length, images: images.length },
    "Bulk data loaded (once)",
  );

  // ── Build lookup maps ─────────────────────────────────────────────────────────
  const variantsByProduct = new Map<string, typeof variants>();
  for (const v of variants) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }

  const marketVariantsByVariant = new Map<string, typeof marketVariants>();
  for (const mv of marketVariants) {
    const list = marketVariantsByVariant.get(mv.variantId) ?? [];
    list.push(mv);
    marketVariantsByVariant.set(mv.variantId, list);
  }

  const translationsByProduct = new Map<string, typeof translations>();
  for (const t of translations) {
    const list = translationsByProduct.get(t.productId) ?? [];
    list.push(t);
    translationsByProduct.set(t.productId, list);
  }

  const imagesByProduct = new Map<string, typeof images>();
  for (const img of images) {
    const list = imagesByProduct.get(img.productId) ?? [];
    list.push(img);
    imagesByProduct.set(img.productId, list);
  }

  const inventoryByVariant = new Map<string, typeof inventory>();
  for (const inv of inventory) {
    const list = inventoryByVariant.get(inv.variantId) ?? [];
    list.push(inv);
    inventoryByVariant.set(inv.variantId, list);
  }

  const recKey = (productId: string, marketCode: string) => `${productId}:${marketCode}`;
  const recByProductMarket = new Map<string, (typeof recommendations)[0]>();
  for (const r of recommendations) {
    recByProductMarket.set(recKey(r.productId, r.marketCode), r);
  }

  // ── 2. Process markets sequentially; publish country + language files inline ──
  //
  // Three accumulator Maps exist: base, language, country rows.
  // The OOM root-cause was keeping all three live across all 5 market iterations.
  //
  // Fix: apply "publish and free" to BOTH country AND language Maps:
  //   • Country files are published when the last market for that country is done.
  //   • Language files are published when the last market for that language is done.
  //     language-fr: triggers after FR (last French-language market)
  //     language-de: triggers after AT (last German-language market)
  //
  // After the loop only baseRows remains alive, then we publish base and return.
  //
  // Peak heap ≈ bulk data (once) + base rows + ONE language group + one country
  // buffer ≈ ~2–3 GB instead of the previous 8 GB.
  // Base rows are deduplicated by id across markets, but only the FIRST
  // occurrence is kept — so we never need the row content again after writing
  // it. Instead of accumulating 134k MetaBaseRow objects in a Map (~GBs of
  // strings) and serializing them all at once, we stream each row straight
  // through a csv-stringify Transform into an App Storage write stream and keep
  // only a Set of seen ids in memory.
  const seenBaseIds = new Set<string>();
  const baseCurrentPath = metaFeedPath(META_FEED_FILES["base"]);
  const baseVersionedPath = versionedPath(baseCurrentPath, versionTs);

  // Partial runs never publish the base layer, so skip the upload entirely.
  const baseUpload = isPartialRun
    ? null
    : createFeedFileWriteStream(baseVersionedPath, "text/csv");
  const baseStringifier = baseUpload ? stringifyStream() : null;
  if (baseStringifier && baseUpload) {
    baseStringifier.pipe(baseUpload.stream);
    baseStringifier.write(META_BASE_HEADERS.map((h) => String(h)));
  }

  async function writeBaseRow(row: MetaBaseRow): Promise<void> {
    if (!baseStringifier) return;
    const record = META_BASE_HEADERS.map(
      (h) => String((row as unknown as Record<string, unknown>)[h as string] ?? ""),
    );
    if (!baseStringifier.write(record)) {
      await once(baseStringifier, "drain");
    }
  }

  // Language rows keyed by language code, published and freed per language group
  const pendingLangRows = new Map<string, Map<string, MetaLanguageRow>>();
  const pendingCountryRows = new Map<string, Map<string, MetaCountryRow>>();
  const processedMarketsByCountry = new Map<string, Set<string>>();
  const processedMarketsByLanguage = new Map<string, Set<string>>();

  // Pre-compute which markets contribute to each language FROM THE FULL CONFIG.
  const languageToMarkets = new Map<string, string[]>();
  for (const mc of allConfiguredMarkets) {
    const language = config.markets.markets[mc]?.language;
    if (!language) continue;
    if (!languageToMarkets.has(language)) languageToMarkets.set(language, []);
    languageToMarkets.get(language)!.push(mc);
  }

  let totalCanonicals = 0;
  let totalEligible = 0;
  let totalIneligible = 0;
  let totalExcluded = 0;

  // Batch feed_items upserts (100 at a time) for efficiency
  type UpsertRow = (typeof feedItemsTable)["$inferInsert"];
  const upsertBatch: UpsertRow[] = [];

  async function flushUpsertBatch(): Promise<void> {
    if (upsertBatch.length === 0) return;
    const batch = upsertBatch.splice(0);
    await db
      .insert(feedItemsTable)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          feedItemsTable.variantId,
          feedItemsTable.marketCode,
          feedItemsTable.language,
          feedItemsTable.channel,
        ],
        set: {
          canonicalJson: sql`excluded.canonical_json`,
          isEligible: sql`excluded.is_eligible`,
          exclusionReason: sql`excluded.exclusion_reason`,
          dataQualityScore: sql`excluded.data_quality_score`,
          checksum: sql`excluded.checksum`,
          updatedAt: new Date(),
        },
      });
  }

  for (const marketCode of targetMarkets) {
    const market = config.markets.markets[marketCode];
    if (!market) continue;
    const { country } = market;

    const { language } = market;
    if (!pendingLangRows.has(language)) pendingLangRows.set(language, new Map());
    if (!processedMarketsByLanguage.has(language)) processedMarketsByLanguage.set(language, new Set());
    if (!pendingCountryRows.has(country)) pendingCountryRows.set(country, new Map());
    if (!processedMarketsByCountry.has(country)) processedMarketsByCountry.set(country, new Set());

    logger.info({ marketCode, country }, "Meta: processing market");
    let marketEligible = 0;
    let marketIneligible = 0;
    let marketExcluded = 0;

    for (const product of products) {
      const productVariants = variantsByProduct.get(product.id) ?? [];

      for (const variant of productVariants) {
        const variantMVs = marketVariantsByVariant.get(variant.id) ?? [];
        const mv = variantMVs.find((m) => m.marketCode === marketCode);
        if (!mv) continue;

        if (!mv.isEligible) {
          marketIneligible++;
          continue;
        }

        const rec = recByProductMarket.get(recKey(product.id, marketCode)) ?? null;

        const canonical = buildCanonical(
          {
            product: product as unknown as ProductRow,
            variant: variant as unknown as VariantRow,
            marketVariants: variantMVs as unknown as MarketVariantRow[],
            translations: (translationsByProduct.get(product.id) ?? []) as unknown as TranslationRow[],
            images: (imagesByProduct.get(product.id) ?? []) as unknown as ImageRow[],
            inventoryLevels: (inventoryByVariant.get(variant.id) ?? []) as unknown as InventoryRow[],
            recommendations: rec as unknown as RecommendationRow | null,
            normalizedBestsellerScore: null,
            config,
          },
          marketCode,
          "meta",
        );

        if (!canonical) {
          marketExcluded++;
          continue;
        }

        // Persist to feed_items (batched)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { generatedAt: _omit, ...stableForChecksum } = canonical;
        const checksum = computeChecksum(stableForChecksum);
        upsertBatch.push({
          variantId: variant.id,
          marketCode,
          language: canonical.language,
          channel: "meta",
          canonicalJson: canonical as unknown as Record<string, unknown>,
          isEligible: canonical.exclusionReasons.length === 0,
          exclusionReason: canonical.exclusionReasons[0] ?? null,
          dataQualityScore: String(canonical.dataQualityScore),
          checksum,
        });
        if (upsertBatch.length >= UPSERT_BATCH_SIZE) {
          await flushUpsertBatch();
        }

        if (canonical.exclusionReasons.length > 0) {
          marketIneligible++;
          continue;
        }

        marketEligible++;
        totalCanonicals++;

        const mapped = mapToMeta(canonical, config);
        if (!mapped) {
          marketExcluded++;
          marketEligible--;
          totalCanonicals--;
          continue;
        }

        const { id, language, country: c, base, language_row, country_row } = mapped;

        // Base: deduplicated by id (same across markets for same variant×market).
        // First occurrence is streamed straight to App Storage; only the id stays
        // in memory.
        if (!seenBaseIds.has(id)) {
          seenBaseIds.add(id);
          await writeBaseRow(base);
        }

        // Language rows: buffered per language group, published and freed when the
        // last market for that language is processed.
        pendingLangRows.get(language)?.set(id, language_row);

        // Country rows buffered until country is complete
        pendingCountryRows.get(c)!.set(id, country_row);
      }
    }

    await flushUpsertBatch();

    processedMarketsByCountry.get(country)!.add(marketCode);
    processedMarketsByLanguage.get(language)!.add(marketCode);
    totalEligible += marketEligible;
    totalIneligible += marketIneligible;
    totalExcluded += marketExcluded;

    logger.info(
      {
        marketCode,
        eligible: marketEligible,
        ineligible: marketIneligible,
        excluded: marketExcluded,
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      "Market processed",
    );

    // If all markets that contribute to this country have been processed,
    // publish the country file immediately and free the buffer.
    // Safety: ALL contributing markets (from full config) must be in targetMarkets —
    // a partial run that only includes BE_FR must not publish country-BE with
    // incomplete data, even though "BE" appears as a processed country.
    const allMarketsForCountry = countryToMarkets.get(country) ?? [];
    const doneMarkets = processedMarketsByCountry.get(country)!;
    const allContributingMarketsInRun = allMarketsForCountry.every((m) => targetMarkets.includes(m));
    const isCountryComplete = allContributingMarketsInRun && allMarketsForCountry.every((m) => doneMarkets.has(m));

    if (isCountryComplete) {
      const key = `country-${country}` as MetaFeedKey;
      const filename = META_FEED_FILES[key];
      const rows = [...(pendingCountryRows.get(country)?.values() ?? [])];
      await publishFeed(key, filename, META_COUNTRY_HEADERS, rows, null, country);
      pendingCountryRows.delete(country);              // free memory immediately
      processedMarketsByCountry.delete(country);
      logger.info({ country, rows: rows.length }, "Country rows published and freed from heap");
    }

    // If all markets for this language have been processed, publish the language
    // file now and free those rows. This keeps peak heap to one language group at
    // a time instead of accumulating fr + de simultaneously.
    // (Skipped for partial runs — shared layers are not safe to publish partially.)
    if (!isPartialRun) {
      const allMarketsForLanguage = languageToMarkets.get(language) ?? [];
      const doneLangMarkets = processedMarketsByLanguage.get(language)!;
      const isLanguageComplete = allMarketsForLanguage.every((m) => doneLangMarkets.has(m));

      if (isLanguageComplete) {
        const key = `language-${language}` as MetaFeedKey;
        const filename = META_FEED_FILES[key];
        if (filename) {
          const rows = [...(pendingLangRows.get(language)?.values() ?? [])];
          await publishFeed(key, filename, META_LANGUAGE_HEADERS, rows, language, null);
          pendingLangRows.delete(language);              // free memory immediately
          processedMarketsByLanguage.delete(language);
          logger.info({ language, rows: rows.length }, "Language rows published and freed from heap");
        }
      }
    }
  }

  logger.info(
    { eligible: totalEligible, ineligible: totalIneligible, excluded: totalExcluded, totalCanonicals },
    "All markets processed",
  );

  // ── Release bulk data from scope ─────────────────────────────────────────────
  //
  // Clearing the lookup Maps removes the Map-level references, but the raw DB
  // result arrays (variants, images, etc.) still hold the row objects via their
  // `const` binding. splice(0) removes all array elements so the row objects
  // become GC-eligible. The base CSV has already been streamed to App Storage
  // row-by-row during the market loop, so no large serialization remains.
  variantsByProduct.clear();
  marketVariantsByVariant.clear();
  translationsByProduct.clear();
  imagesByProduct.clear();
  inventoryByVariant.clear();
  recByProductMarket.clear();
  // Also clear the raw arrays so the individual row objects are GC-eligible
  products.splice(0);
  variants.splice(0);
  marketVariants.splice(0);
  translations.splice(0);
  images.splice(0);
  inventory.splice(0);
  recommendations.splice(0);

  // ── 3. Publish base file (language files already published inline) ────────────
  //
  // For full runs: language files were published and their Maps freed during the
  // market loop. Only baseRows remains alive here.
  //
  // For partial runs: shared layers (base + language) are NOT published because
  // they would be incomplete. Set placeholder results and return.
  if (isPartialRun) {
    logger.info(
      { reason: "partial-market run" },
      "Skipping base + language shared layers — not safe to publish partial catalog",
    );
    feedResults["base"] = { itemCount: seenBaseIds.size, storagePath: baseVersionedPath, published: false, sha256: "" };
    // Language placeholders: if inline publishing didn't run (isPartialRun=true),
    // set empty placeholders for any language not yet in feedResults.
    for (const lang of ["fr", "de"]) {
      const key = `language-${lang}` as MetaFeedKey;
      if (!feedResults[key]) {
        const langRowCount = pendingLangRows.get(lang)?.size ?? 0;
        feedResults[key] = { itemCount: langRowCount, storagePath: versionedPath(metaFeedPath(META_FEED_FILES[key]), versionTs), published: false, sha256: "" };
      }
    }
  } else {
    // Base file was streamed row-by-row during the market loop; finish the
    // upload and run the normal gate/manifest/DB flow on the uploaded file.
    baseStringifier!.end();
    const { sha256: baseSha256, bytes: baseBytes } = await baseUpload!.done;
    logger.info(
      { rows: seenBaseIds.size, bytes: baseBytes, heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) },
      "Base CSV streamed to storage",
    );
    await finalizeFeed("base", baseCurrentPath, baseVersionedPath, seenBaseIds.size, baseSha256, null, null);
  }

  // Fill placeholder results for country files skipped in partial runs
  for (const country of ["BE", "FR", "DE", "AT", "CH", "LU"]) {
    const key = `country-${country}` as MetaFeedKey;
    if (!feedResults[key]) {
      const filename = META_FEED_FILES[key];
      feedResults[key] = { itemCount: 0, storagePath: metaFeedPath(filename), published: false, sha256: "" };
      logger.info({ country, reason: "country not in run markets" }, "Skipping country layer publish");
    }
  }

  const result: MetaRunResult = {
    totalCanonicals,
    files: feedResults,
    dryRun,
    durationMs: Date.now() - startedAt,
  };

  // The public operational feeds are a single flat file per language. Legacy
  // layer files above remain available while channel configuration is migrated.
  const languageFiles = await publishMetaLanguageFeeds(config, {
    syncRunId: options.syncRunId,
    dryRun,
  });
  logger.info({ languageFiles }, "Meta language feeds complete");

  logger.info(
    { totalCanonicals, durationMs: result.durationMs },
    "Meta export complete",
  );

  return result;
}
