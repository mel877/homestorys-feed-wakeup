/**
 * Translations sync — fetches localized product content per language.
 *
 * Uses Shopify's `translatableResources` API to get product titles,
 * descriptions, and handles in each non-primary language.
 *
 * The primary locale (usually "fr") is already stored from the product sync.
 * This module fills in translations for all other configured languages.
 */

import { db, productsTable, productTranslationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";
import { loadConfig } from "../config";
import type { ShopifyClient } from "./client";
import type { SyncRunTracker } from "./sync-run-tracker";
import type { PageInfo } from "./types";

const logger = rootLogger.child({ module: "sync-translations" });

// ── GraphQL query ─────────────────────────────────────────────────────────────

const TRANSLATABLE_RESOURCES_QUERY = `
  query TranslatableProducts($locale: String!, $cursor: String) {
    translatableResources(resourceType: PRODUCT, first: 100, after: $cursor) {
      nodes {
        resourceId
        translations(locale: $locale) {
          key
          value
          locale
          outdated
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface TranslationNode {
  key: string;
  value: string | null;
  locale: string;
  outdated: boolean;
}

interface TranslatableResource {
  resourceId: string;
  translations: TranslationNode[];
}

interface TranslatableResourcesResponse {
  translatableResources: {
    nodes: TranslatableResource[];
    pageInfo: PageInfo;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract just the numeric Shopify ID from a GID. */
function extractShopifyId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

/** Build a GID for a product from its numeric ID. */
function buildProductGid(numericId: string): string {
  return `gid://shopify/Product/${numericId}`;
}

// ── Main sync ─────────────────────────────────────────────────────────────────

export async function syncTranslations(
  client: ShopifyClient,
  tracker: SyncRunTracker,
  primaryLocale = "fr",
): Promise<void> {
  logger.info("Starting translation sync");
  const config = loadConfig();
  const languages = config.languages.languages.map((l) => l.code);

  // Get all locales we need to sync (skip primary — already handled by product sync)
  const targetLocales = languages.filter((l) => l !== primaryLocale);

  logger.info({ targetLocales, primaryLocale }, "Syncing translations");

  // Build product GID → DB ID map
  const dbProducts = await db
    .select({ id: productsTable.id, shopifyGid: productsTable.shopifyGid, handle: productsTable.handle })
    .from(productsTable)
    .where(eq(productsTable.status, "active"));

  const productByGid = new Map(dbProducts.map((p) => [p.shopifyGid, p]));

  // Sync each locale separately
  for (const locale of targetLocales) {
    logger.info({ locale }, "Syncing locale");
    await syncLocale(client, locale, productByGid, tracker);
  }

  logger.info("Translation sync complete");
}

async function syncLocale(
  client: ShopifyClient,
  locale: string,
  productByGid: Map<string, { id: string; shopifyGid: string; handle: string }>,
  tracker: SyncRunTracker,
): Promise<void> {
  let cursor: string | null = null;
  let pageCount = 0;
  let upserted = 0;

  do {
    const result: TranslatableResourcesResponse = await client.request<TranslatableResourcesResponse>(
      TRANSLATABLE_RESOURCES_QUERY,
      { locale, cursor },
      { expectedCost: 20 },
    );
    tracker.bumpApiCalls();

    const translatableResources: TranslatableResourcesResponse["translatableResources"] = result.translatableResources;
    const { nodes, pageInfo } = translatableResources;

    for (const resource of nodes) {
      const gid = resource.resourceId;
      const product = productByGid.get(gid);

      if (!product) {
        // Product might not be in our DB yet (draft, etc.)
        continue;
      }

      // Map Shopify translation keys to our columns
      const translationMap: Record<string, string | null> = {};
      for (const t of resource.translations) {
        if (t.value) translationMap[t.key] = t.value;
      }

      const title = translationMap["title"] ?? null;
      const description = translationMap["body_html"] ?? null;
      const handle = translationMap["handle"] ?? null;

      if (!title && !description && !handle) {
        // No translations for this locale — skip
        continue;
      }

      await db
        .insert(productTranslationsTable)
        .values({
          productId: product.id,
          language: locale,
          title: title ?? "",
          description,
          handle,
        })
        .onConflictDoUpdate({
          target: [
            productTranslationsTable.productId,
            productTranslationsTable.language,
          ],
          set: {
            // Only overwrite the existing title when a translated title
            // exists; never wipe a previously-synced title with "".
            ...(title !== null ? { title } : {}),
            description,
            handle,
            updatedAt: new Date(),
          },
        });

      upserted++;
      tracker.bumpChanged();
      tracker.bumpRead();
    }

    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    pageCount++;

    if (pageCount % 10 === 0) {
      logger.debug({ locale, pageCount, upserted }, "Translation sync progress");
    }
  } while (cursor);

  if (upserted === 0) {
    logger.warn(
      { locale, pageCount },
      "Locale sync complete with 0 translations upserted — " +
        "this usually means the locale is not published in Shopify admin. " +
        "Go to Shopify admin → Settings → Languages and publish the locale, " +
        "then run a full sync to populate translations.",
    );
  } else {
    logger.info({ locale, upserted, pageCount }, "Locale sync complete");
  }
}

// ── Targeted single-product translation sync ─────────────────────────────────

const SINGLE_PRODUCT_TRANSLATIONS_QUERY = `
  query SingleProductTranslations($id: ID!, $locale: String!) {
    translatableResource(resourceId: $id) {
      resourceId
      translations(locale: $locale) {
        key
        value
        locale
        outdated
      }
    }
  }
`;

interface SingleTranslatableResponse {
  translatableResource: {
    resourceId: string;
    translations: TranslationNode[];
  } | null;
}

export async function syncProductTranslations(
  client: ShopifyClient,
  productDbId: string,
  shopifyProductGid: string,
  primaryLocale = "fr",
): Promise<void> {
  const config = loadConfig();
  const languages = config.languages.languages.map((l) => l.code);
  const targetLocales = languages.filter((l) => l !== primaryLocale);

  for (const locale of targetLocales) {
    const result = await client.request<SingleTranslatableResponse>(
      SINGLE_PRODUCT_TRANSLATIONS_QUERY,
      { id: shopifyProductGid, locale },
      { expectedCost: 5 },
    );

    const resource = result.translatableResource;
    if (!resource) continue;

    const translationMap: Record<string, string | null> = {};
    for (const t of resource.translations) {
      if (t.value) translationMap[t.key] = t.value;
    }

    const title = translationMap["title"] ?? null;
    const description = translationMap["body_html"] ?? null;
    const handle = translationMap["handle"] ?? null;

    if (!title && !description && !handle) continue;

    await db
      .insert(productTranslationsTable)
      .values({
        productId: productDbId,
        language: locale,
        title: title ?? "",
        description,
        handle,
      })
      .onConflictDoUpdate({
        target: [
          productTranslationsTable.productId,
          productTranslationsTable.language,
        ],
        set: {
          // Only overwrite the existing title when a translated title exists;
          // never wipe a previously-synced title with an empty string.
          ...(title !== null ? { title } : {}),
          description,
          handle,
          updatedAt: new Date(),
        },
      });
  }
}
