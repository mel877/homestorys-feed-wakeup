import type { CanonicalProduct } from "../canonical/types";
import type { AppConfig, MetaShippingRate } from "../config/schemas";
import { isValidSalePrice } from "../promotions/index";

function selectShippingPrice(rate: MetaShippingRate, orderValue: number): string | null {
  const tiers = rate.tiers?.length
    ? rate.tiers
    : rate.price
      ? [{ minimum_order_value: 0, price: rate.price }]
      : [];

  let selected: (typeof tiers)[number] | null = null;
  for (const tier of tiers) {
    if (tier.minimum_order_value <= orderValue && (
      !selected || tier.minimum_order_value > selected.minimum_order_value
    )) {
      selected = tier;
    }
  }

  return selected?.price ?? null;
}

/**
 * Resolves the one product-level shipping amount that Google and Meta export
 * formats accept. The config uses subtotal tiers, so products at or above a
 * free-shipping threshold export a zero-price shipping value.
 */
export function buildMarketShipping(canonical: CanonicalProduct, config: AppConfig): string {
  const market = config.markets.markets[canonical.market];
  if (!market) return "";

  const rate = config.shipping.meta_feed_rates?.[market.country];
  if (!rate) return "";

  const payableAmount = canonical.isOnSale && isValidSalePrice(canonical.price, canonical.salePrice)
    ? canonical.salePrice.amount
    : canonical.price.amount;
  const price = selectShippingPrice(rate, payableAmount);
  if (price === null) return "";

  return `${market.country}::${rate.service}:${price} ${rate.currency}`;
}