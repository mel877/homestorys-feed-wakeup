/**
 * Market pricing sync.
 *
 * For each of our configured markets, determines prices per variant by:
 * 1. Fetching all Shopify Markets and matching them to our market codes
 * 2. Fetching all PriceLists (which hold market-specific price overrides)
 * 3. Fetching base variant prices (the store's primary currency prices)
 * 4. Computing per-variant per-market price = override || adjustment || base price
 * 5. Upserting market_variants rows (availability is set separately by inventory sync)
 */

import { db, variantsTable, productsTable, marketVariantsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";
import { loadConfig } from "../config";
import type { ShopifyClient } from "./client";
import type { SyncRunTracker } from "./sync-run-tracker";
import type { ShopifyMarket, ShopifyPriceList, PageInfo } from "./types";

const logger = rootLogger.child({ module: "sync-markets" });

// ── GraphQL queries ───────────────────────────────────────────────────────────

const MARKETS_QUERY = `
  {
    markets(first: 50) {
      nodes {
        id
        name
        handle
        enabled
        primary
        currencySettings {
          baseCurrency { currencyCode }
        }
        webPresence {
          defaultLocale { locale }
          domain { host }
          rootUrls { locale url }
        }
      }
    }
  }
`;

const PRICE_LISTS_QUERY = `
  query PriceLists($cursor: String) {
    priceLists(first: 20, after: $cursor) {
      nodes {
        id
        name
        currency
        parent {
          adjustment { type value }
        }
        catalog {
          ... on MarketCatalog {
            markets(first: 10) {
              nodes { id name handle }
            }
          }
        }
        prices(first: 250) {
          nodes {
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
            variant { id }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRICE_LIST_PRICES_QUERY = `
  query PriceListPrices($priceListId: ID!, $cursor: String) {
    priceList(id: $priceListId) {
      prices(first: 250, after: $cursor) {
        nodes {
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
          variant { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const BASE_PRICES_QUERY = `
  query VariantBasePrices($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      edges {
        node {
          id
          price
          compareAtPrice
          product { id handle }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ── Market matching ───────────────────────────────────────────────────────────

interface MarketConfig {
  country: string;
  language: string;
  currency: string;
}

/**
 * Match a Shopify market to one of our configured market codes.
 * Strategy: match by handle pattern or name keywords.
 */
function matchMarketCode(
  market: ShopifyMarket,
  ourMarkets: Record<string, MarketConfig>,
): string | null {
  const locale = market.webPresence?.defaultLocale?.locale ?? "";
  const handle = market.handle.toLowerCase();
  const name = market.name.toLowerCase();

  for (const [code, config] of Object.entries(ourMarkets)) {
    if (config.language !== locale) continue;

    const country = config.country.toLowerCase();
    if (
      handle.includes(country) ||
      name.includes(country) ||
      name.includes(countryName(config.country))
    ) {
      return code;
    }
  }

  // Fallback: match only on locale for markets with unique locale
  const matchingByLocale = Object.entries(ourMarkets).filter(
    ([, m]) => m.language === locale,
  );
  if (matchingByLocale.length === 1) {
    return matchingByLocale[0]![0];
  }

  return null;
}

function countryName(code: string): string {
  const names: Record<string, string> = {
    BE: "belgium",
    FR: "france",
    DE: "germany",
    AT: "austria",
    NL: "netherlands",
    GB: "united kingdom",
    US: "united states",
  };
  return names[code] ?? code.toLowerCase();
}

/** Get base URL for a market (used for product URL construction). */
function getMarketBaseUrl(market: ShopifyMarket): string | null {
  const wp = market.webPresence;
  if (!wp) return null;

  const defaultLocaleUrl = wp.rootUrls.find(
    (r) => r.locale === wp.defaultLocale?.locale,
  );
  const url = defaultLocaleUrl?.url ?? wp.rootUrls[0]?.url;
  if (!url) return null;
  return url.endsWith("/") ? url : url + "/";
}

// ── Price list price fetching ─────────────────────────────────────────────────

interface VariantPrice {
  variantGid: string;
  price: string;
  compareAtPrice: string | null;
  currency: string;
}

async function fetchAllPriceListPrices(
  client: ShopifyClient,
  priceListId: string,
  tracker: SyncRunTracker,
): Promise<VariantPrice[]> {
  const prices: VariantPrice[] = [];
  let cursor: string | null = null;

  type PriceListResult = {
    priceList: {
      prices: {
        nodes: Array<{
          price: { amount: string; currencyCode: string };
          compareAtPrice: { amount: string; currencyCode: string } | null;
          variant: { id: string };
        }>;
        pageInfo: PageInfo;
      };
    } | null;
  };

  do {
    const result: PriceListResult = await client.request<PriceListResult>(
      PRICE_LIST_PRICES_QUERY, { priceListId, cursor }, { expectedCost: 20 });

    tracker.bumpApiCalls();

    const priceListNode = result.priceList;
    const page = priceListNode?.prices;
    if (!page) break;

    for (const node of page.nodes) {
      prices.push({
        variantGid: node.variant.id,
        price: node.price.amount,
        compareAtPrice: node.compareAtPrice?.amount ?? null,
        currency: node.price.currencyCode,
      });
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return prices;
}

/** Fetch base prices for all variants (paginated). */
async function fetchAllBasePrices(
  client: ShopifyClient,
  tracker: SyncRunTracker,
): Promise<Map<string, { price: string; compareAtPrice: string | null; productHandle: string }>> {
  const prices = new Map<string, { price: string; compareAtPrice: string | null; productHandle: string }>();
  let cursor: string | null = null;

  type BasePricesResult = {
    productVariants: {
      edges: Array<{
        node: {
          id: string;
          price: string;
          compareAtPrice: string | null;
          product: { id: string; handle: string };
        };
      }>;
      pageInfo: PageInfo;
    };
  };

  do {
    const result: BasePricesResult = await client.request<BasePricesResult>(
      BASE_PRICES_QUERY, { cursor }, { expectedCost: 30 });

    tracker.bumpApiCalls();
    const page: BasePricesResult["productVariants"] = result.productVariants;

    for (const { node } of page.edges) {
      prices.set(node.id, {
        price: node.price,
        compareAtPrice: node.compareAtPrice,
        productHandle: node.product.handle,
      });
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return prices;
}

// ── Main sync ─────────────────────────────────────────────────────────────────

export async function syncMarketPricing(
  client: ShopifyClient,
  tracker: SyncRunTracker,
): Promise<void> {
  logger.info("Starting market pricing sync");
  const config = loadConfig();
  const ourMarkets = config.markets.markets;

  // 1. Fetch Shopify markets
  const marketsResult = await client.request<{ markets: { nodes: ShopifyMarket[] } }>(
    MARKETS_QUERY,
    {},
    { expectedCost: 5 },
  );
  tracker.bumpApiCalls();

  const shopifyMarkets = marketsResult.markets.nodes;
  const marketMapping = new Map<string, { code: string; market: ShopifyMarket }>();

  for (const market of shopifyMarkets) {
    const code = matchMarketCode(market, ourMarkets);
    if (code) {
      marketMapping.set(market.id, { code, market });
      logger.info({ shopifyMarketId: market.id, name: market.name, code }, "Market matched");
    } else {
      logger.warn(
        { shopifyMarketId: market.id, name: market.name, handle: market.handle },
        "Shopify market not matched to any config market — skipping",
      );
    }
  }

  // 2. Fetch base prices for all variants from Shopify
  logger.info("Fetching base variant prices...");
  const basePrices = await fetchAllBasePrices(client, tracker);
  logger.info({ count: basePrices.size }, "Base prices fetched");

  // 3. Fetch price lists and build override maps per market
  const priceListOverrides = new Map<string, Map<string, VariantPrice>>();
  // marketCode → (variantGid → price override)

  const priceListsResult = await client.request<{
    priceLists: {
      nodes: ShopifyPriceList[];
      pageInfo: PageInfo;
    };
  }>(PRICE_LISTS_QUERY, { cursor: null }, { expectedCost: 20 });
  tracker.bumpApiCalls();

  for (const priceList of priceListsResult.priceLists.nodes) {
    // In API 2025-01+, the market is found via catalog (MarketCatalog inline fragment).
    // A price list may span multiple markets; we associate it with each matched one.
    const catalogMarkets = priceList.catalog?.markets?.nodes ?? [];
    if (catalogMarkets.length === 0) continue;

    for (const marketInfo of catalogMarkets) {
    const marketEntry = marketMapping.get(marketInfo.id);
    if (!marketEntry) continue;

    const marketCode = marketEntry.code;
    const overrideMap = priceListOverrides.get(marketCode) ?? new Map<string, VariantPrice>();

    // Fetch all prices for this price list (initial page already in the response)
    const initialPrices = priceList.prices.nodes.map((p) => ({
      variantGid: p.variant.id,
      price: p.price.amount,
      compareAtPrice: p.compareAtPrice?.amount ?? null,
      currency: p.price.currencyCode,
    }));

    let allPrices = initialPrices;
    if (priceList.prices.pageInfo.hasNextPage) {
      const extraPrices = await fetchAllPriceListPrices(client, priceList.id, tracker);
      allPrices = [...initialPrices, ...extraPrices];
    }

    for (const p of allPrices) {
      overrideMap.set(p.variantGid, p);
    }
    priceListOverrides.set(marketCode, overrideMap);

    logger.info(
      { marketCode, priceListId: priceList.id, overrideCount: overrideMap.size },
      "Price list loaded",
    );
    } // end for catalogMarkets
  } // end for priceLists

  // 4. Load variant DB IDs (need to map shopifyGid → DB id)
  const dbVariants = await db
    .select({
      id: variantsTable.id,
      shopifyGid: variantsTable.shopifyGid,
    })
    .from(variantsTable);

  const variantDbIdMap = new Map(dbVariants.map((v) => [v.shopifyGid, v.id]));

  // 5. Upsert market_variants for each variant × market
  const marketCodes = Object.keys(ourMarkets);
  let upserted = 0;
  const BATCH_SIZE = 200;
  const rows: (typeof marketVariantsTable.$inferInsert)[] = [];

  for (const [variantGid, base] of basePrices) {
    const variantDbId = variantDbIdMap.get(variantGid);
    if (!variantDbId) continue; // Not yet synced

    tracker.bumpRead();

    for (const marketCode of marketCodes) {
      const marketEntry = [...marketMapping.values()].find((m) => m.code === marketCode);
      const override = priceListOverrides.get(marketCode)?.get(variantGid);

      const finalPrice = override?.price ?? base.price;
      const finalCompareAt = override?.compareAtPrice ?? base.compareAtPrice;
      const currency =
        override?.currency ??
        marketEntry?.market.currencySettings.baseCurrency.currencyCode ??
        "EUR";

      // Construct product URL if market base URL is available
      let productUrl: string | null = null;
      if (marketEntry) {
        const baseUrl = getMarketBaseUrl(marketEntry.market);
        if (baseUrl) productUrl = `${baseUrl}products/${base.productHandle}`;
      }

      rows.push({
        variantId: variantDbId,
        marketCode,
        priceAmount: finalPrice,
        priceCurrency: currency,
        compareAtPriceAmount: finalCompareAt,
        availability: "out_of_stock", // Will be updated by inventory sync
        productUrl,
        isEligible: true,
      });

      if (rows.length >= BATCH_SIZE) {
        await flushMarketVariantBatch(rows, tracker);
        upserted += rows.length;
        rows.length = 0;
      }
    }
  }

  if (rows.length > 0) {
    await flushMarketVariantBatch(rows, tracker);
    upserted += rows.length;
  }

  logger.info({ upserted }, "Market pricing sync complete");
}

async function flushMarketVariantBatch(
  rows: (typeof marketVariantsTable.$inferInsert)[],
  tracker: SyncRunTracker,
): Promise<void> {
  await db
    .insert(marketVariantsTable)
    .values(rows)
    .onConflictDoUpdate({
      target: [marketVariantsTable.variantId, marketVariantsTable.marketCode],
      set: {
        priceAmount: sql`excluded.price_amount`,
        priceCurrency: sql`excluded.price_currency`,
        compareAtPriceAmount: sql`excluded.compare_at_price_amount`,
        productUrl: sql`excluded.product_url`,
        updatedAt: new Date(),
      },
    })
    .catch(async () => {
      // Fallback: upsert one-by-one if batch fails
      for (const row of rows) {
        try {
          await db
            .insert(marketVariantsTable)
            .values(row)
            .onConflictDoUpdate({
              target: [marketVariantsTable.variantId, marketVariantsTable.marketCode],
              set: {
                priceAmount: row.priceAmount,
                priceCurrency: row.priceCurrency,
                compareAtPriceAmount: row.compareAtPriceAmount,
                productUrl: row.productUrl,
                updatedAt: new Date(),
              },
            });
          tracker.bumpChanged();
        } catch (err) {
          logger.warn({ err, variantId: row.variantId, marketCode: row.marketCode }, "Market variant upsert failed");
          tracker.bumpWarnings();
        }
      }
    });

  tracker.bumpChanged(rows.length);
}
