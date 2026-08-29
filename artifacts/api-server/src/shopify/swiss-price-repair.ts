import {
  db,
  marketVariantsTable,
  productsTable,
  variantsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppConfig } from "../config";
import { processAllCanonicals } from "../exporters/canonical-reader";
import { mapToGoogleRow } from "../exporters/google/mapper";
import { mapToMeta } from "../exporters/meta/mapper";
import { isValidSalePrice } from "../promotions";
import type { ShopifyClient } from "./client";

export const SHOPIFY_VARIANT_BATCH_SIZE = 250;
const DB_BATCH_SIZE = 500;
const SWISS_MARKETS = ["CH_DE", "CH_FR"] as const;

type SwissMarket = (typeof SWISS_MARKETS)[number];

export interface ContextualPriceNode {
  id: string;
  contextualPricing: {
    price: { amount: string; currencyCode: string };
    compareAtPrice: { amount: string; currencyCode: string } | null;
  } | null;
}

export interface ValidatedSwissPrice {
  priceAmount: string;
  compareAtPriceAmount: string | null;
  currency: "CHF";
}

export interface SwissPriceValidationIssue {
  variantGid: string;
  code:
    | "MISSING_RESPONSE"
    | "MISSING_CONTEXTUAL_PRICE"
    | "NON_CHF_PRICE"
    | "INVALID_PRICE"
    | "NON_CHF_COMPARE_AT"
    | "INVALID_COMPARE_AT"
    | "DUPLICATE_REQUEST"
    | "DUPLICATE_RESPONSE"
    | "UNREQUESTED_RESPONSE";
  message: string;
}

export class SwissPriceValidationError extends Error {
  constructor(public readonly issues: SwissPriceValidationIssue[]) {
    super(`Swiss contextual price validation failed for ${issues.length} response(s)`);
    this.name = "SwissPriceValidationError";
  }
}

export interface SwissMarketUpdate {
  variantId: string;
  marketCode: SwissMarket;
  priceAmount: string;
  compareAtPriceAmount: string | null;
  priceCurrency: "CHF";
}

interface EligibleSwissVariants {
  all: Set<string>;
  googleByMarket: Record<SwissMarket, Set<string>>;
  metaByMarket: Record<SwissMarket, Set<string>>;
}

export interface SwissPriceRepairReport {
  dryRun: boolean;
  targetedVariants: number;
  queriedAtShopify: number;
  correctedVariants: number;
  shopifyApiCalls: number;
  remainingEligibleEur: number;
  remainingTotalEur: number;
  remainingExcludedEur: number;
  eligibleCurrencyDistribution: Record<SwissMarket, { CHF: number; EUR: number; other: number }>;
  validPromotions: {
    uniqueVariants: number;
    byMarket: Record<SwissMarket, number>;
  };
  contextualPricesMatch: boolean;
  noCurrencyConversionPerformed: true;
  validators: {
    google: { passed: boolean; rowsChecked: number; errors: string[] };
    meta: { passed: boolean; rowsChecked: number; errors: string[] };
  };
}

const CONTEXTUAL_PRICES_QUERY = `
  query SwissContextualPrices($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        contextualPricing(context: { country: CH }) {
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
        }
      }
    }
  }
`;

function isPositiveMoney(value: string): boolean {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}

function isNonNegativeMoney(value: string): boolean {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0;
}

function chunkArray<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

export function chunkVariantIds(
  ids: string[],
  batchSize = SHOPIFY_VARIANT_BATCH_SIZE,
): string[][] {
  if (batchSize < 1 || batchSize > SHOPIFY_VARIANT_BATCH_SIZE) {
    throw new Error(`Shopify batch size must be between 1 and ${SHOPIFY_VARIANT_BATCH_SIZE}`);
  }
  return chunkArray(ids, batchSize);
}

export function validateContextualPrices(
  requestedIds: string[],
  nodes: Array<ContextualPriceNode | null>,
): Map<string, ValidatedSwissPrice> {
  const requested = new Set(requestedIds);
  const byId = new Map<string, ContextualPriceNode>();
  const issues: SwissPriceValidationIssue[] = [];

  if (requested.size !== requestedIds.length) {
    const seen = new Set<string>();
    for (const id of requestedIds) {
      if (seen.has(id)) {
        issues.push({
          variantGid: id,
          code: "DUPLICATE_REQUEST",
          message: "The same Shopify variant was requested more than once",
        });
      }
      seen.add(id);
    }
  }

  for (const node of nodes) {
    if (!node) continue;
    if (!requested.has(node.id)) {
      issues.push({
        variantGid: node.id,
        code: "UNREQUESTED_RESPONSE",
        message: "Shopify returned a variant that was not requested",
      });
      continue;
    }
    if (byId.has(node.id)) {
      issues.push({
        variantGid: node.id,
        code: "DUPLICATE_RESPONSE",
        message: "Shopify returned the same variant more than once",
      });
      continue;
    }
    byId.set(node.id, node);
  }

  const validated = new Map<string, ValidatedSwissPrice>();
  for (const id of requestedIds) {
    const node = byId.get(id);
    if (!node) {
      issues.push({
        variantGid: id,
        code: "MISSING_RESPONSE",
        message: "Shopify did not return this variant",
      });
      continue;
    }
    if (!node.contextualPricing) {
      issues.push({
        variantGid: id,
        code: "MISSING_CONTEXTUAL_PRICE",
        message: "Shopify returned no contextual pricing for country CH",
      });
      continue;
    }

    const { price, compareAtPrice } = node.contextualPricing;
    let valid = true;
    if (price.currencyCode !== "CHF") {
      issues.push({
        variantGid: id,
        code: "NON_CHF_PRICE",
        message: `Expected contextual price in CHF, received ${price.currencyCode}`,
      });
      valid = false;
    }
    if (!isPositiveMoney(price.amount)) {
      issues.push({
        variantGid: id,
        code: "INVALID_PRICE",
        message: `Contextual price must be positive, received ${price.amount}`,
      });
      valid = false;
    }
    if (compareAtPrice?.currencyCode && compareAtPrice.currencyCode !== "CHF") {
      issues.push({
        variantGid: id,
        code: "NON_CHF_COMPARE_AT",
        message: `Expected contextual compare-at price in CHF, received ${compareAtPrice.currencyCode}`,
      });
      valid = false;
    }
    if (compareAtPrice && !isNonNegativeMoney(compareAtPrice.amount)) {
      issues.push({
        variantGid: id,
        code: "INVALID_COMPARE_AT",
        message: `Contextual compare-at price is invalid: ${compareAtPrice.amount}`,
      });
      valid = false;
    }

    if (valid) {
      validated.set(id, {
        priceAmount: price.amount,
        compareAtPriceAmount: compareAtPrice?.amount ?? null,
        currency: "CHF",
      });
    }
  }

  if (issues.length > 0) throw new SwissPriceValidationError(issues);
  return validated;
}

export function buildSwissMarketUpdates(
  pricesByVariantId: Map<string, ValidatedSwissPrice>,
): SwissMarketUpdate[] {
  const updates: SwissMarketUpdate[] = [];
  for (const [variantId, price] of pricesByVariantId) {
    for (const marketCode of SWISS_MARKETS) {
      updates.push({
        variantId,
        marketCode,
        priceAmount: price.priceAmount,
        compareAtPriceAmount: price.compareAtPriceAmount,
        priceCurrency: "CHF",
      });
    }
  }
  return updates;
}

export function assertPairedEurScope(
  variantIds: string[],
  rows: Array<{
    variantId: string;
    marketCode: string;
    priceCurrency: string | null;
  }>,
): void {
  const byKey = new Map(rows.map((row) => [`${row.variantId}:${row.marketCode}`, row]));
  const invalid: string[] = [];
  for (const variantId of variantIds) {
    const de = byKey.get(`${variantId}:CH_DE`);
    const fr = byKey.get(`${variantId}:CH_FR`);
    if (!de || !fr || de.priceCurrency !== "EUR" || fr.priceCurrency !== "EUR") {
      invalid.push(variantId);
    }
  }
  if (invalid.length > 0) {
    throw new Error(
      `Paired EUR scope validation failed for ${invalid.length} variant(s): ` +
        invalid.slice(0, 20).join(", "),
    );
  }
}

async function recalculateEligibleSwissVariants(
  config: AppConfig,
): Promise<EligibleSwissVariants> {
  const result: EligibleSwissVariants = {
    all: new Set(),
    googleByMarket: { CH_DE: new Set(), CH_FR: new Set() },
    metaByMarket: { CH_DE: new Set(), CH_FR: new Set() },
  };

  for (const channel of ["google", "meta"] as const) {
    await processAllCanonicals(
      config,
      { markets: [...SWISS_MARKETS], channel, persistFeedItems: false },
      (canonical) => {
        const market = canonical.market as SwissMarket;
        if (!SWISS_MARKETS.includes(market)) return;
        result[channel === "google" ? "googleByMarket" : "metaByMarket"][market].add(
          canonical.variantId,
        );
        result.all.add(canonical.variantId);
      },
    );
  }

  return result;
}

async function loadSwissMarketRows(variantIds?: string[]) {
  if (variantIds && variantIds.length === 0) return [];
  const batches = variantIds ? chunkArray(variantIds, DB_BATCH_SIZE) : [undefined];
  const rows: Array<typeof marketVariantsTable.$inferSelect> = [];
  for (const batch of batches) {
    rows.push(
      ...(await db
        .select()
        .from(marketVariantsTable)
        .innerJoin(variantsTable, eq(variantsTable.id, marketVariantsTable.variantId))
        .innerJoin(productsTable, eq(productsTable.id, variantsTable.productId))
        .where(
          and(
            eq(productsTable.status, "active"),
            inArray(marketVariantsTable.marketCode, [...SWISS_MARKETS]),
            ...(batch ? [inArray(marketVariantsTable.variantId, batch)] : []),
          ),
        )
        .then((joined) => joined.map((row) => row.market_variants))),
    );
  }
  return rows;
}

async function loadVariantGids(variantIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const batch of chunkArray(variantIds, DB_BATCH_SIZE)) {
    const rows = await db
      .select({ id: variantsTable.id, shopifyGid: variantsTable.shopifyGid })
      .from(variantsTable)
      .where(inArray(variantsTable.id, batch));
    for (const row of rows) result.set(row.id, row.shopifyGid);
  }
  return result;
}

async function fetchContextualSwissPrices(
  client: ShopifyClient,
  gids: string[],
): Promise<{ prices: Map<string, ValidatedSwissPrice>; apiCalls: number }> {
  const nodes: Array<ContextualPriceNode | null> = [];
  let apiCalls = 0;
  for (const ids of chunkVariantIds(gids)) {
    const response = await client.request<{ nodes: Array<ContextualPriceNode | null> }>(
      CONTEXTUAL_PRICES_QUERY,
      { ids },
      { expectedCost: 50 },
    );
    apiCalls++;
    nodes.push(...response.nodes);
  }
  return { prices: validateContextualPrices(gids, nodes), apiCalls };
}

async function applyUpdatesAtomically(updates: SwissMarketUpdate[]): Promise<void> {
  const expectedRowByKey = new Map<
    string,
    { currency: string | null; price: string | null; compareAt: string | null }
  >();
  const currentRows = await loadSwissMarketRows([
    ...new Set(updates.map((row) => row.variantId)),
  ]);
  for (const row of currentRows) {
    expectedRowByKey.set(`${row.variantId}:${row.marketCode}`, {
      currency: row.priceCurrency,
      price: row.priceAmount,
      compareAt: row.compareAtPriceAmount,
    });
  }

  for (const update of updates) {
    const key = `${update.variantId}:${update.marketCode}`;
    if (!expectedRowByKey.has(key)) {
      throw new Error(`Missing ${update.marketCode} row for targeted variant ${update.variantId}`);
    }
  }

  await db.transaction(async (tx) => {
    let updatedRows = 0;
    for (const rows of chunkArray(updates, DB_BATCH_SIZE)) {
      const values = sql.join(
        rows.map((row) => {
          const expected = expectedRowByKey.get(`${row.variantId}:${row.marketCode}`)!;
          return sql`(
          ${row.variantId}::uuid,
          ${row.marketCode}::text,
          ${row.priceAmount}::numeric,
          ${row.priceCurrency}::text,
          ${row.compareAtPriceAmount}::numeric,
          ${expected.currency}::text,
          ${expected.price}::numeric,
          ${expected.compareAt}::numeric
        )`;
        }),
        sql`, `,
      );
      const result = await tx.execute(sql`
        UPDATE market_variants AS target
        SET
          price_amount = source.price_amount,
          price_currency = source.price_currency,
          compare_at_price_amount = source.compare_at_price_amount,
          updated_at = NOW()
        FROM (VALUES ${values}) AS source(
          variant_id,
          market_code,
          price_amount,
          price_currency,
          compare_at_price_amount,
          expected_currency,
          expected_price_amount,
          expected_compare_at_price_amount
        )
        WHERE target.variant_id = source.variant_id
          AND target.market_code = source.market_code
          AND target.price_currency IS NOT DISTINCT FROM source.expected_currency
          AND target.price_amount IS NOT DISTINCT FROM source.expected_price_amount
          AND target.compare_at_price_amount IS NOT DISTINCT FROM source.expected_compare_at_price_amount
        RETURNING target.variant_id
      `);
      updatedRows += result.rows.length;
    }
    if (updatedRows !== updates.length) {
      throw new Error(
        `Atomic Swiss price update touched ${updatedRows} row(s), expected ${updates.length}`,
      );
    }
  });
}

function parseFeedMoney(value: string): { amount: number; currency: string } | null {
  const match = value.match(/^(-?\d+(?:\.\d+)?)\s+([A-Z]{3})$/);
  return match ? { amount: Number(match[1]), currency: match[2]! } : null;
}

async function buildPostRepairReport(
  config: AppConfig,
  targeted: Set<string>,
  shopifyApiCalls: number,
  dryRun: boolean,
): Promise<Omit<SwissPriceRepairReport, "queriedAtShopify">> {
  const eligible = await recalculateEligibleSwissVariants(config);
  const marketRows = await loadSwissMarketRows();
  const rowByKey = new Map(
    marketRows.map((row) => [`${row.variantId}:${row.marketCode}`, row]),
  );

  const allEligibleIds = new Set([
    ...eligible.googleByMarket.CH_DE,
    ...eligible.googleByMarket.CH_FR,
    ...eligible.metaByMarket.CH_DE,
    ...eligible.metaByMarket.CH_FR,
  ]);
  const activeEurIds = new Set(
    marketRows.filter((row) => row.priceCurrency === "EUR").map((row) => row.variantId),
  );
  const remainingEligibleEur = [...allEligibleIds].filter((id) => activeEurIds.has(id)).length;
  const remainingTotalEur = activeEurIds.size;

  const distribution = {
    CH_DE: { CHF: 0, EUR: 0, other: 0 },
    CH_FR: { CHF: 0, EUR: 0, other: 0 },
  };
  for (const market of SWISS_MARKETS) {
    const marketEligibleIds = new Set([
      ...eligible.googleByMarket[market],
      ...eligible.metaByMarket[market],
    ]);
    for (const id of marketEligibleIds) {
      const currency = rowByKey.get(`${id}:${market}`)?.priceCurrency;
      if (currency === "CHF") distribution[market].CHF++;
      else if (currency === "EUR") distribution[market].EUR++;
      else distribution[market].other++;
    }
  }

  const googleErrors: string[] = [];
  const metaErrors: string[] = [];
  let googleRowsChecked = 0;
  let metaRowsChecked = 0;
  const promotionIds = new Set<string>();
  const promotionsByMarket = { CH_DE: 0, CH_FR: 0 };

  for (const channel of ["google", "meta"] as const) {
    await processAllCanonicals(
      config,
      { markets: [...SWISS_MARKETS], channel, persistFeedItems: false },
      (canonical) => {
        if (targeted.size > 0 && !targeted.has(canonical.variantId)) return;
        const market = canonical.market as SwissMarket;
        if (channel === "google") {
          const row = mapToGoogleRow(canonical, config);
          googleRowsChecked++;
          const price = row ? parseFeedMoney(row.price) : null;
          const sale = row?.sale_price ? parseFeedMoney(row.sale_price) : null;
          if (!row || price?.currency !== "CHF") {
            googleErrors.push(`${canonical.variantId}:${market}:price`);
          }
          if (sale && (!price || sale.currency !== "CHF" || sale.amount >= price.amount)) {
            googleErrors.push(`${canonical.variantId}:${market}:sale_price`);
          }
        } else {
          const mapped = mapToMeta(canonical, config);
          metaRowsChecked++;
          const price = mapped ? parseFeedMoney(mapped.country_row.price) : null;
          const sale = mapped?.country_row.sale_price
            ? parseFeedMoney(mapped.country_row.sale_price)
            : null;
          if (!mapped || price?.currency !== "CHF") {
            metaErrors.push(`${canonical.variantId}:${market}:price`);
          }
          if (sale && (!price || sale.currency !== "CHF" || sale.amount >= price.amount)) {
            metaErrors.push(`${canonical.variantId}:${market}:sale_price`);
          }
        }

        if (isValidSalePrice(canonical.price, canonical.salePrice)) {
          promotionsByMarket[market]++;
          promotionIds.add(canonical.variantId);
        }
      },
    );
  }

  let contextualPricesMatch = true;
  for (const id of targeted) {
    const de = rowByKey.get(`${id}:CH_DE`);
    const fr = rowByKey.get(`${id}:CH_FR`);
    if (
      !de ||
      !fr ||
      de.priceCurrency !== "CHF" ||
      fr.priceCurrency !== "CHF" ||
      de.priceAmount !== fr.priceAmount ||
      de.compareAtPriceAmount !== fr.compareAtPriceAmount
    ) {
      contextualPricesMatch = false;
      break;
    }
  }

  return {
    dryRun,
    targetedVariants: targeted.size,
    correctedVariants: dryRun ? 0 : targeted.size,
    shopifyApiCalls,
    remainingEligibleEur,
    remainingTotalEur,
    remainingExcludedEur: Math.max(0, remainingTotalEur - remainingEligibleEur),
    eligibleCurrencyDistribution: distribution,
    validPromotions: {
      uniqueVariants: promotionIds.size,
      byMarket: promotionsByMarket,
    },
    contextualPricesMatch,
    noCurrencyConversionPerformed: true,
    validators: {
      google: {
        passed: googleErrors.length === 0,
        rowsChecked: googleRowsChecked,
        errors: googleErrors.slice(0, 100),
      },
      meta: {
        passed: metaErrors.length === 0,
        rowsChecked: metaRowsChecked,
        errors: metaErrors.slice(0, 100),
      },
    },
  };
}

export async function runSwissPriceRepair(options: {
  config: AppConfig;
  client: ShopifyClient;
  apply: boolean;
}): Promise<SwissPriceRepairReport> {
  const eligible = await recalculateEligibleSwissVariants(options.config);
  const eligibleIds = [...eligible.all];
  const currentRows = await loadSwissMarketRows(eligibleIds);
  const eurIds = new Set(
    currentRows.filter((row) => row.priceCurrency === "EUR").map((row) => row.variantId),
  );
  const targetedIds = eligibleIds.filter((id) => eurIds.has(id)).sort();
  assertPairedEurScope(targetedIds, currentRows);
  const gidsById = await loadVariantGids(targetedIds);

  if (gidsById.size !== targetedIds.length) {
    throw new Error(
      `Missing Shopify GID for ${targetedIds.length - gidsById.size} targeted variant(s)`,
    );
  }

  const idsByGid = new Map([...gidsById].map(([id, gid]) => [gid, id]));
  const gids = targetedIds.map((id) => gidsById.get(id)!);
  const { prices: pricesByGid, apiCalls } = await fetchContextualSwissPrices(
    options.client,
    gids,
  );
  const pricesByVariantId = new Map<string, ValidatedSwissPrice>();
  for (const [gid, price] of pricesByGid) {
    pricesByVariantId.set(idsByGid.get(gid)!, price);
  }

  const updates = buildSwissMarketUpdates(pricesByVariantId);
  if (options.apply) await applyUpdatesAtomically(updates);

  return {
    ...(await buildPostRepairReport(
      options.config,
      new Set(targetedIds),
      apiCalls,
      !options.apply,
    )),
    queriedAtShopify: gids.length,
  };
}