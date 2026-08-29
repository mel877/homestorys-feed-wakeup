/**
 * Promotion / sale engine — spec section 15.
 *
 * Rule: IF compare_at_price > price THEN is_on_sale = true
 * Never invent a promotion. Fail-safe: invalid prices → exclude that market.
 */

import type { Money, DiscountBucket } from "../canonical/types";

export interface PromotionResult {
  isOnSale: boolean;
  discountPercentage: number | null;
  discountBucket: DiscountBucket;
  salePrice: Money | null;
  /** When true, the pricing data is invalid and this market should be excluded. */
  priceInvalid: boolean;
  invalidReason?: string;
}

/**
 * Channel-level safety guard for promotional prices.
 * A sale price is publishable only when it is positive, uses the same currency,
 * and is strictly lower than the regular price.
 */
export function isValidSalePrice(
  price: Money,
  salePrice: Money | null | undefined,
): salePrice is Money {
  return !!salePrice
    && salePrice.amount > 0
    && salePrice.currency === price.currency
    && salePrice.amount < price.amount;
}

/** Discount bucket bands per spec section 15.
 *  All bounds are inclusive: a 10% discount falls into "1_10", a 20% into "11_20", etc.
 *  The 70_plus bucket begins at 70 (inclusive); 51_70 therefore ends at 69.
 */
const DISCOUNT_BUCKETS: Array<{ key: DiscountBucket; min: number; max: number | null }> = [
  { key: "none",   min: 0,  max: 0  },
  { key: "1_10",  min: 1,  max: 10 },
  { key: "11_20", min: 11, max: 20 },
  { key: "21_30", min: 21, max: 30 },
  { key: "31_50", min: 31, max: 50 },
  { key: "51_70", min: 51, max: 69 }, // 70 belongs to 70_plus (see test)
  { key: "70_plus", min: 70, max: null },
];

/**
 * Compute promotion state for a variant in a specific market.
 *
 * @param priceAmount - effective price (string from DB numeric)
 * @param compareAtAmount - compare-at price (string from DB numeric, nullable)
 * @param currency - ISO 4217 currency code
 */
export function computePromotion(
  priceAmount: string | null | undefined,
  compareAtAmount: string | null | undefined,
  currency: string,
): PromotionResult {
  // ── Validate price ──────────────────────────────────────────────────────
  if (!priceAmount) {
    return {
      isOnSale: false,
      discountPercentage: null,
      discountBucket: "none",
      salePrice: null,
      priceInvalid: true,
      invalidReason: "MISSING_PRICE",
    };
  }

  const price = parseFloat(priceAmount);
  if (isNaN(price) || price <= 0) {
    return {
      isOnSale: false,
      discountPercentage: null,
      discountBucket: "none",
      salePrice: null,
      priceInvalid: true,
      invalidReason: `INVALID_PRICE: price=${priceAmount}`,
    };
  }

  if (!currency || currency.length !== 3) {
    return {
      isOnSale: false,
      discountPercentage: null,
      discountBucket: "none",
      salePrice: null,
      priceInvalid: true,
      invalidReason: `MISSING_CURRENCY`,
    };
  }

  const priceObj: Money = {
    amount: price,
    currency,
    formatted: formatMoney(price, currency),
  };

  // ── Check for sale ──────────────────────────────────────────────────────
  if (!compareAtAmount) {
    // No compare-at → regular price, not on sale
    return {
      isOnSale: false,
      discountPercentage: null,
      discountBucket: "none",
      salePrice: null,
      priceInvalid: false,
    };
  }

  const compareAt = parseFloat(compareAtAmount);
  if (isNaN(compareAt) || compareAt <= 0) {
    // Invalid compare-at: ignore it but don't fail the whole product
    return {
      isOnSale: false,
      discountPercentage: null,
      discountBucket: "none",
      salePrice: null,
      priceInvalid: false,
    };
  }

  // Spec section 88: if sale_price > original, that's invalid
  if (price >= compareAt) {
    // compare_at ≤ price → not a sale (equal or compare-at is lower, which is nonsense)
    return {
      isOnSale: false,
      discountPercentage: null,
      discountBucket: "none",
      salePrice: null,
      priceInvalid: false,
    };
  }

  // Valid sale
  const discountPct = ((compareAt - price) / compareAt) * 100;
  const bucket = assignDiscountBucket(discountPct);

  return {
    isOnSale: true,
    discountPercentage: Math.round(discountPct * 10) / 10, // 1 decimal
    discountBucket: bucket,
    salePrice: priceObj, // In Google/Meta feeds, salePrice = current price when on sale
    priceInvalid: false,
  };
}

/** Assign a discount bucket from a percentage. */
export function assignDiscountBucket(pct: number): DiscountBucket {
  if (pct <= 0) return "none";
  for (const band of DISCOUNT_BUCKETS) {
    // Inclusive upper bound: e.g. exactly 10% → "1_10", exactly 20% → "11_20"
    if (pct >= band.min && (band.max === null || pct <= band.max)) {
      return band.key;
    }
  }
  return "70_plus";
}

/** Build a Money object from raw string values. Returns null if invalid. */
export function buildMoney(
  amount: string | null | undefined,
  currency: string | null | undefined,
): Money | null {
  if (!amount || !currency) return null;
  const num = parseFloat(amount);
  if (isNaN(num) || num < 0) return null;
  return {
    amount: num,
    currency,
    formatted: formatMoney(num, currency),
  };
}

/** Format a money value with currency symbol. */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("fr-BE", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
