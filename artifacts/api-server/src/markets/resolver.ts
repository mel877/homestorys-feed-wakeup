/**
 * Market / Language resolver — spec sections 13, 14.
 *
 * Rules:
 * - Language content comes from the language master (FR/DE/EN/IT), not per-country
 * - DE, AT, BE_DE all use MASTER_DE (same content, different prices/shipping/URLs)
 * - Prices ALWAYS from market_variants (Shopify Markets is source of truth)
 * - Never cross-apply a price from one market to another
 */

import type { MarketsConfig } from "../config/schemas";
import type { MarketVariantRow, TranslationRow } from "../canonical/types";

export interface ResolvedMarket {
  marketCode: string;
  language: "fr" | "de" | "en" | "it";
  country: string;
  currency: string;
  label: string;
  /** Canonical storefront base URL for this market (from config/markets.yaml). */
  base_url: string | undefined;
  /** Optional commercial source when two languages share one Shopify market. */
  pricing_market: string | undefined;
}

export interface ResolvedContent {
  title: string | null; // localised title from DB translation
  description: string | null; // localised description from DB translation
  handle: string | null; // localised URL handle
}

export interface ResolvedPricing {
  priceAmount: string | null;
  priceCurrency: string;
  compareAtPriceAmount: string | null;
  productUrl: string | null;
  availability: string;
  isEligible: boolean;
}

/**
 * Resolve market configuration for a market code.
 * Returns null if the market code is not configured.
 */
export function resolveMarket(
  marketCode: string,
  config: MarketsConfig,
): ResolvedMarket | null {
  const market = config.markets[marketCode];
  if (!market) return null;

  return {
    marketCode,
    language: market.language,
    country: market.country,
    currency: market.currency,
    label: market.label ?? marketCode,
    base_url: market.base_url,
    pricing_market: market.pricing_market,
  };
}

/**
 * Resolve localised content for a product+variant in a given language.
 *
 * Language content is shared across all markets that use the same master language.
 * e.g. DE, AT, BE_DE all use the German translation row.
 *
 * Fallback chain for description:
 *   1. Localised translation (e.g. German)
 *   2. French translation (primary locale — always present after product sync)
 *   3. Any other available translation
 *
 * This ensures German/English/Italian market products remain eligible in all
 * channels even before their Shopify translations are set up. Without this
 * fallback, Meta would exclude ALL products from non-French markets with
 * MISSING_REQUIRED_TRANSLATION because it requires a non-empty description.
 */
export function resolveContent(
  language: string,
  productTitle: string, // base title from products table (primary locale = fr)
  translations: TranslationRow[],
): ResolvedContent {
  // Find matching translation by language code
  const translation = translations.find((t) => t.language === language);

  // Description fallback: French primary → any available translation
  const fallbackDescription =
    translations.find((t) => t.language === "fr" && t.description)?.description ??
    translations.find((t) => t.description)?.description ??
    null;

  return {
    title: translation?.title ?? productTitle,
    description: translation?.description ?? fallbackDescription,
    handle: translation?.handle ?? null,
  };
}

/**
 * Resolve market-specific pricing from market_variants row.
 * Returns null if no market variant row found for this market.
 */
export function resolvePricing(
  marketCode: string,
  marketVariants: MarketVariantRow[],
  defaultCurrency = "EUR",
): ResolvedPricing | null {
  const mv = marketVariants.find((r) => r.marketCode === marketCode);
  if (!mv) return null;

  return {
    priceAmount: mv.priceAmount,
    priceCurrency: mv.priceCurrency ?? defaultCurrency,
    compareAtPriceAmount: mv.compareAtPriceAmount,
    productUrl: mv.productUrl,
    availability: mv.availability,
    isEligible: mv.isEligible,
  };
}

/**
 * Build all configured markets list from config.
 */
export function getAllMarkets(config: MarketsConfig): ResolvedMarket[] {
  return Object.entries(config.markets).map(([code, market]) => ({
    marketCode: code,
    language: market.language,
    country: market.country,
    currency: market.currency,
    label: market.label ?? code,
    base_url: market.base_url,
    pricing_market: market.pricing_market,
  }));
}

/**
 * Get all market codes that share a given language.
 */
export function getMarketsForLanguage(
  language: string,
  config: MarketsConfig,
): string[] {
  return Object.entries(config.markets)
    .filter(([, m]) => m.language === language)
    .map(([code]) => code);
}
