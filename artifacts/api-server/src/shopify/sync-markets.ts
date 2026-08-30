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

import { db, variantsTable, marketVariantsTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";
import { loadConfig } from "../config";
import { buildShopifyProductUrl } from "../markets/resolver";
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
          contextualPricing(context: { country: CH }) {
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
          }
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
    CH: "switzerland",
    LU: "luxembourg",
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

interface BaseVariantPrice {
  price: string;
  compareAtPrice: string | null;
  productHandle: string;
  swissPrice: {
    price: string;
    compareAtPrice: string | null;
    currency: string;
  } | null;
}

export function assertShopifyMarketCurrencies(
  markets: Record<string, { country: string; currency: string }>,
): void {
  for (const [marketCode, market] of Object.entries(markets)) {
    if (market.country === "CH" && market.currency !== "CHF") {
      throw new Error(
        `Swiss market ${marketCode} must be configured with CHF, received ${market.currency}`,
      );
    }
  }
}

export function selectShopifyMarketPrice({
  marketCode,
  country,
  configuredCurrency,
  base,
  override,
}: {
  marketCode: string;
  country: string;
  configuredCurrency: string;
  base: BaseVariantPrice;
  override: VariantPrice | undefined;
}): Pick<VariantPrice, "price" | "compareAtPrice" | "currency"> {
  if (country === "CH") {
    if (!base.swissPrice || base.swissPrice.currency !== configuredCurrency) {
      throw new Error(
        `Shopify contextual pricing for ${marketCode} must use ${configuredCurrency}`,
      );
    }
    return base.swissPrice;
  }

  const selected = override
    ? {
        price: override.price,
        compareAtPrice: override.compareAtPrice,
        currency: override.currency,
      }
    : {
        price: base.price,
        compareAtPrice: base.compareAtPrice,
        currency: configuredCurrency,
      };
  if (selected.currency !== configuredCurrency) {
    throw new Error(
      `Shopify pricing for ${marketCode} must use ${configuredCurrency}`,
    );
  }
  return selected;
}

export const DURABLE_PRICING_VALIDATION_BATCH_SIZE = 5_000;
export const DURABLE_PRICING_WRITE_VARIANT_BATCH_SIZE = 500;

export type MarketPricingCommitUnit = (
  checkpoint: Record<string, unknown>,
  writer: (tx: any) => Promise<void>,
) => Promise<void>;

export function advancePricingValidationBatch(input: {
  checkpoint: Record<string, any>;
  markets: Record<string, { country: string; currency: string }>;
  maxChecks?: number;
}): Record<string, any> {
  const swissMarkets = Object.entries(input.markets)
    .filter(([, market]) => market.country === "CH");
  const basePrices = input.checkpoint.basePrices ?? [];
  const maxChecks = Math.max(
    1,
    input.maxChecks ?? DURABLE_PRICING_VALIDATION_BATCH_SIZE,
  );
  let marketIndex = Number(input.checkpoint.validateMarketIndex ?? 0);
  let baseIndex = Number(input.checkpoint.validateBaseIndex ?? 0);
  let checked = 0;

  while (checked < maxChecks) {
    const marketEntry = swissMarkets[marketIndex];
    if (!marketEntry) {
      return {
        ...input.checkpoint,
        stage: "write",
        baseIndex: 0,
        marketIndex: 0,
      };
    }
    const base = basePrices[baseIndex];
    if (!base) {
      marketIndex++;
      baseIndex = 0;
      continue;
    }
    const [marketCode, market] = marketEntry;
    selectShopifyMarketPrice({
      marketCode,
      country: market.country,
      configuredCurrency: market.currency,
      base,
      override: undefined,
    });
    baseIndex++;
    checked++;
  }

  return {
    ...input.checkpoint,
    validateMarketIndex: marketIndex,
    validateBaseIndex: baseIndex,
  };
}

/**
 * The HTTP durable variant deliberately retains its intermediate Shopify
 * responses in the step checkpoint.  This makes the read/validate/write
 * boundary deterministic: in particular every CH contextual price is
 * validated before the first market_variants write.
 */
export async function syncMarketPricingSlice(
  client: ShopifyClient,
  tracker: SyncRunTracker,
  checkpoint: Record<string, unknown>,
  heartbeat: () => Promise<boolean>,
  commitUnit?: MarketPricingCommitUnit,
): Promise<{ completed: boolean; checkpoint: Record<string, unknown> }> {
  const state = checkpoint as Record<string, any>;
  const config = loadConfig();
  const ourMarkets = config.markets.markets;
  assertShopifyMarketCurrencies(ourMarkets);

  if (!state.stage) {
    if (!await heartbeat()) return { completed: false, checkpoint: state };
    const response = await client.request<{ markets: { nodes: ShopifyMarket[] } }>(
      MARKETS_QUERY, {}, { expectedCost: 5 },
    );
    tracker.bumpApiCalls();
    const mapping = response.markets.nodes.flatMap((market) => {
      const code = matchMarketCode(market, ourMarkets);
      return code ? [{ code, market }] : [];
    });
    return { completed: false, checkpoint: {
      stage: "priceLists", mapping, priceLists: [], priceListsCursor: null,
    } };
  }

  if (state.stage === "priceLists") {
    if (!await heartbeat()) return { completed: false, checkpoint: state };
    const response = await client.request<any>(
      PRICE_LISTS_QUERY, { cursor: state.priceListsCursor }, { expectedCost: 20 },
    );
    tracker.bumpApiCalls();
    const mapping = new Map((state.mapping ?? []).map((entry: any) => [entry.market.id, entry.code]));
    const priceLists = [...(state.priceLists ?? [])];
    for (const list of response.priceLists.nodes) {
      const marketCodes = (list.catalog?.markets?.nodes ?? [])
        .map((market: any) => mapping.get(market.id)).filter(Boolean);
      if (!marketCodes.length) continue;
      priceLists.push({
        id: list.id, marketCodes,
        prices: list.prices.nodes.map((price: any) => ({
          variantGid: price.variant.id, price: price.price.amount,
          compareAtPrice: price.compareAtPrice?.amount ?? null, currency: price.price.currencyCode,
        })),
        cursor: list.prices.pageInfo.hasNextPage ? list.prices.pageInfo.endCursor : null,
      });
    }
    const cursor = response.priceLists.pageInfo.hasNextPage
      ? response.priceLists.pageInfo.endCursor : null;
    return { completed: false, checkpoint: cursor
      ? { ...state, priceLists, priceListsCursor: cursor }
      : { ...state, stage: "priceListPrices", priceLists, priceListIndex: 0 } };
  }

  if (state.stage === "priceListPrices") {
    const lists = [...(state.priceLists ?? [])];
    const index = Number(state.priceListIndex ?? 0);
    const list = lists[index];
    if (!list) return { completed: false, checkpoint: { ...state, stage: "basePrices", baseCursor: null, basePrices: [] } };
    if (!list.cursor) {
      return { completed: false, checkpoint: { ...state, priceListIndex: index + 1 } };
    }
    if (!await heartbeat()) return { completed: false, checkpoint: state };
    const response = await client.request<any>(
      PRICE_LIST_PRICES_QUERY, { priceListId: list.id, cursor: list.cursor }, { expectedCost: 20 },
    );
    tracker.bumpApiCalls();
    list.prices.push(...response.priceList.prices.nodes.map((price: any) => ({
      variantGid: price.variant.id, price: price.price.amount,
      compareAtPrice: price.compareAtPrice?.amount ?? null, currency: price.price.currencyCode,
    })));
    list.cursor = response.priceList.prices.pageInfo.hasNextPage
      ? response.priceList.prices.pageInfo.endCursor : null;
    lists[index] = list;
    return { completed: false, checkpoint: { ...state, priceLists: lists } };
  }

  if (state.stage === "basePrices") {
    if (!await heartbeat()) return { completed: false, checkpoint: state };
    const response = await client.request<any>(
      BASE_PRICES_QUERY, { cursor: state.baseCursor }, { expectedCost: 30 },
    );
    tracker.bumpApiCalls();
    const basePrices = [...(state.basePrices ?? []), ...response.productVariants.edges.map(({ node }: any) => ({
      variantGid: node.id, price: node.price, compareAtPrice: node.compareAtPrice,
      productHandle: node.product.handle,
      swissPrice: node.contextualPricing ? {
        price: node.contextualPricing.price.amount,
        compareAtPrice: node.contextualPricing.compareAtPrice?.amount ?? null,
        currency: node.contextualPricing.price.currencyCode,
      } : null,
    }))];
    const cursor = response.productVariants.pageInfo.hasNextPage
      ? response.productVariants.pageInfo.endCursor : null;
    return { completed: false, checkpoint: cursor
      ? { ...state, basePrices, baseCursor: cursor }
      : { ...state, basePrices, stage: "validate" } };
  }

  if (state.stage === "validate") {
    // Do not move this validation into the write stage: that would allow a
    // non-CHF Swiss price to partially update another market.
    if (!await heartbeat()) return { completed: false, checkpoint: state };
    return {
      completed: false,
      checkpoint: advancePricingValidationBatch({
        checkpoint: state,
        markets: ourMarkets,
      }),
    };
  }

  const basePrices = state.basePrices ?? [];
  let index = Number(state.baseIndex ?? 0);
  let marketIndex = Number(state.marketIndex ?? 0);
  const markets = Object.entries(ourMarkets);
  const entries = new Map((state.mapping ?? []).map((entry: any) => [entry.code, entry.market]));
  if (commitUnit) {
    while (index < basePrices.length) {
      if (!await heartbeat()) {
        return { completed: false, checkpoint: { ...state, baseIndex: index, marketIndex } };
      }
      const batchStart = index;
      const batchEnd = Math.min(
        basePrices.length,
        batchStart + DURABLE_PRICING_WRITE_VARIANT_BATCH_SIZE,
      );
      const firstMarketIndex = marketIndex;
      const nextCheckpoint = {
        ...state,
        stage: batchEnd >= basePrices.length ? "complete" : "write",
        baseIndex: batchEnd,
        marketIndex: 0,
      };
      await commitUnit(nextCheckpoint, async (tx) => {
        const batch = basePrices.slice(batchStart, batchEnd);
        const storedVariants = await tx.select({
          id: variantsTable.id,
          shopifyGid: variantsTable.shopifyGid,
        })
          .from(variantsTable)
          .where(inArray(
            variantsTable.shopifyGid,
            batch.map((base: any) => base.variantGid),
          ));
        const variantsByGid = new Map<string, { id: string; shopifyGid: string }>(
          storedVariants.map((variant: { id: string; shopifyGid: string }) =>
            [variant.shopifyGid, variant]),
        );
        const writes: Array<typeof marketVariantsTable.$inferInsert> = [];
        for (let baseIndex = batchStart; baseIndex < batchEnd; baseIndex++) {
          const base = basePrices[baseIndex];
          const variant = variantsByGid.get(base.variantGid);
          if (!variant) continue;
          const overrides = new Map<string, VariantPrice>();
          for (const list of state.priceLists ?? []) {
            for (const code of list.marketCodes) {
              const found = list.prices.find(
                (price: VariantPrice) => price.variantGid === base.variantGid,
              );
              if (found) overrides.set(code, found);
            }
          }
          const startMarket = baseIndex === batchStart ? firstMarketIndex : 0;
          for (let nextMarketIndex = startMarket;
            nextMarketIndex < markets.length;
            nextMarketIndex++) {
            const [marketCode, market] = markets[nextMarketIndex]!;
            const selected = selectShopifyMarketPrice({
              marketCode,
              country: market.country,
              configuredCurrency: market.currency,
              base,
              override: overrides.get(marketCode),
            });
            const shopifyMarket = entries.get(marketCode) as ShopifyMarket | undefined;
            const root = shopifyMarket ? getMarketBaseUrl(shopifyMarket) : market.base_url;
            writes.push({
              variantId: variant.id,
              marketCode,
              priceAmount: selected.price,
              priceCurrency: selected.currency,
              compareAtPriceAmount: selected.compareAtPrice,
              availability: "out_of_stock",
              productUrl: root
                ? buildShopifyProductUrl(root, base.productHandle, base.variantGid)
                : null,
              isEligible: true,
            });
            tracker.bumpChanged();
          }
        }
        if (writes.length > 0) {
          await tx.insert(marketVariantsTable).values(writes).onConflictDoUpdate({
            target: [marketVariantsTable.variantId, marketVariantsTable.marketCode],
            set: {
              priceAmount: sql`excluded.price_amount`,
              priceCurrency: sql`excluded.price_currency`,
              compareAtPriceAmount: sql`excluded.compare_at_price_amount`,
              productUrl: sql`excluded.product_url`,
              updatedAt: new Date(),
            },
          });
        }
      });
      index = batchEnd;
      marketIndex = 0;
      if (index >= basePrices.length) {
        return { completed: true, checkpoint: nextCheckpoint };
      }
    }
  }
  // Continue across variants while the caller's deadline/lease heartbeat allows
  // it.  `marketIndex` is deliberately persisted after every committed upsert.
  while (index < basePrices.length) {
    if (!await heartbeat()) {
      return { completed: false, checkpoint: { ...state, baseIndex: index, marketIndex } };
    }
    const base = basePrices[index];
    const [variant] = await db.select({ id: variantsTable.id })
      .from(variantsTable).where(sql`${variantsTable.shopifyGid} = ${base.variantGid}`).limit(1);
    if (variant) {
      const overrides = new Map<string, VariantPrice>();
      for (const list of state.priceLists ?? []) {
        for (const code of list.marketCodes) {
          const found = list.prices.find((price: VariantPrice) => price.variantGid === base.variantGid);
          if (found) overrides.set(code, found);
        }
      }
      for (; marketIndex < markets.length; marketIndex++) {
        if (!await heartbeat()) {
          return { completed: false, checkpoint: { ...state, baseIndex: index, marketIndex } };
        }
        const [marketCode, market] = markets[marketIndex]!;
        const selected = selectShopifyMarketPrice({ marketCode, country: market.country,
          configuredCurrency: market.currency, base, override: overrides.get(marketCode) });
        const shopifyMarket = entries.get(marketCode) as ShopifyMarket | undefined;
        const root = shopifyMarket ? getMarketBaseUrl(shopifyMarket) : market.base_url;
        await db.insert(marketVariantsTable).values({
          variantId: variant.id, marketCode, priceAmount: selected.price, priceCurrency: selected.currency,
          compareAtPriceAmount: selected.compareAtPrice, availability: "out_of_stock",
          productUrl: root ? buildShopifyProductUrl(root, base.productHandle, base.variantGid) : null,
          isEligible: true,
        }).onConflictDoUpdate({
          target: [marketVariantsTable.variantId, marketVariantsTable.marketCode],
          set: { priceAmount: sql`excluded.price_amount`, priceCurrency: sql`excluded.price_currency`,
            compareAtPriceAmount: sql`excluded.compare_at_price_amount`,
            productUrl: sql`excluded.product_url`, updatedAt: new Date() },
        });
        tracker.bumpChanged();
      }
    }
    index++;
    marketIndex = 0;
  }
  return { completed: true, checkpoint: { ...state, stage: "complete", baseIndex: index, marketIndex: 0 } };
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
): Promise<Map<string, BaseVariantPrice>> {
  const prices = new Map<string, BaseVariantPrice>();
  let cursor: string | null = null;

  type BasePricesResult = {
    productVariants: {
      edges: Array<{
        node: {
          id: string;
          price: string;
          compareAtPrice: string | null;
          contextualPricing: {
            price: { amount: string; currencyCode: string };
            compareAtPrice: { amount: string; currencyCode: string } | null;
          } | null;
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
        swissPrice: node.contextualPricing
          ? {
              price: node.contextualPricing.price.amount,
              compareAtPrice: node.contextualPricing.compareAtPrice?.amount ?? null,
              currency: node.contextualPricing.price.currencyCode,
            }
          : null,
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
  assertShopifyMarketCurrencies(ourMarkets);

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

  // Validate the Shopify buyer-facing Swiss price source before any DB writes.
  // Raw PriceList entries can be expressed in the shop currency even when the
  // market itself is CHF; contextualPricing is the final price shown in CH.
  const swissMarkets = Object.entries(ourMarkets).filter(([, market]) => market.country === "CH");
  for (const [marketCode, market] of swissMarkets) {
    for (const base of basePrices.values()) {
      selectShopifyMarketPrice({
        marketCode,
        country: market.country,
        configuredCurrency: market.currency,
        base,
        override: undefined,
      });
    }
  }

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

  // Build a code → marketEntry lookup once (avoids O(n) search inside the hot loop).
  const marketEntryByCode = new Map<string, { code: string; market: ShopifyMarket }>();
  for (const entry of marketMapping.values()) {
    marketEntryByCode.set(entry.code, entry);
  }

  for (const [variantGid, base] of basePrices) {
    const variantDbId = variantDbIdMap.get(variantGid);
    if (!variantDbId) continue; // Not yet synced

    tracker.bumpRead();

    for (const marketCode of marketCodes) {
      const marketEntry = marketEntryByCode.get(marketCode);
      const override = priceListOverrides.get(marketCode)?.get(variantGid);
      const marketConfig = ourMarkets[marketCode]!;
      const selectedPrice = selectShopifyMarketPrice({
        marketCode,
        country: marketConfig.country,
        configuredCurrency: marketConfig.currency,
        base,
        override,
      });

      // Use the exact localized Shopify market presence and deep-link the
      // variant so the landing-page price matches the feed row.
      const baseUrl = marketEntry
        ? getMarketBaseUrl(marketEntry.market)
        : marketConfig.base_url;
      const productUrl = baseUrl
        ? buildShopifyProductUrl(baseUrl, base.productHandle, variantGid)
        : null;

      rows.push({
        variantId: variantDbId,
        marketCode,
        priceAmount: selectedPrice.price,
        priceCurrency: selectedPrice.currency,
        compareAtPriceAmount: selectedPrice.compareAtPrice,
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
    .then(() => {
      // Batch succeeded — count once here.
      tracker.bumpChanged(rows.length);
    })
    .catch(async () => {
      // Fallback: upsert one-by-one if batch fails.
      // Only bumpChanged per successful row — do NOT call bumpChanged(rows.length) again.
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
}
