/**
 * Meta Catalog Feed Mapper
 *
 * Converts a CanonicalProduct into the Meta localized catalog architecture:
 *   BASE    — identity, classification, images (language-agnostic)
 *   LANGUAGE — title, description, link (per language: fr, de)
 *   COUNTRY  — price, availability, shipping (per market country: BE, FR, DE, AT)
 *
 * Spec reference: §1329-1362 (Meta architecture), §571-635 (canonical model).
 *
 * Audit fixes applied (2026-08):
 *   Fix 3  — google_product_category uses metaProductCategory (Meta taxonomy) with
 *             fallback to googleProductCategory (was always googleProductCategory)
 *   Fix 4  — condition respects isOutlet flag (was always "new")
 *   Fix 8  — return_policy_info added; derived from returnClass → returns config
 *   Fix 9  — shipping field added; per-country flat rate configurable in shipping.yaml
 *   Fix 14 — product_type uses metaProductCategory hierarchy when available
 */

import type { CanonicalProduct } from "../../canonical/types";
import type { AppConfig } from "../../config/schemas";
import { buildFeedDescription } from "../feed-content";
import { buildMarketShipping } from "../shipping";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Base catalog row — language-agnostic product identity. */
export interface MetaBaseRow {
  id: string;
  item_group_id: string;
  gtin: string;
  mpn: string;
  brand: string;
  condition: string;
  image_link: string;
  additional_image_link: string;
  lifestyle_image_link: string;
  google_product_category: string;
  product_type: string;
  color: string;
  material: string;
  age_group: string;
  gender: string;
  /** Fix 8: per-product return policy override. Format: {"is_final_sale":"false","return_policy_days":"14"} */
  return_policy_info: string;
  custom_label_0: string;
  custom_label_1: string;
  custom_label_2: string;
  custom_label_3: string;
  custom_label_4: string;
}

/** Language override row — localised text and link. */
export interface MetaLanguageRow {
  id: string;
  title: string;
  description: string;
  link: string;
}

/** Country/market override row — price, availability, and shipping. */
export interface MetaCountryRow {
  id: string;
  price: string;
  sale_price: string;
  sale_price_effective_date: string;
  availability: string;
  /** Fix 9: flat shipping rate for this country. Format: country::service:price currency */
  shipping: string;
}

/** All three layers bundled together for a single canonical product. */
export interface MetaMapped {
  id: string;
  language: string;
  country: string;
  base: MetaBaseRow;
  language_row: MetaLanguageRow;
  country_row: MetaCountryRow;
}

// ── Column definitions ─────────────────────────────────────────────────────────

export const META_BASE_HEADERS: (keyof MetaBaseRow)[] = [
  "id",
  "item_group_id",
  "gtin",
  "mpn",
  "brand",
  "condition",
  "image_link",
  "additional_image_link",
  "lifestyle_image_link",
  "google_product_category",
  "product_type",
  "color",
  "material",
  "age_group",
  "gender",
  "return_policy_info", // Fix 8
  "custom_label_0",
  "custom_label_1",
  "custom_label_2",
  "custom_label_3",
  "custom_label_4",
];

export const META_LANGUAGE_HEADERS: (keyof MetaLanguageRow)[] = [
  "id",
  "title",
  "description",
  "link",
];

export const META_COUNTRY_HEADERS: (keyof MetaCountryRow)[] = [
  "id",
  "price",
  "sale_price",
  "sale_price_effective_date",
  "availability",
  "shipping", // Fix 9
];

// ── Fix 4: condition — outlet awareness ───────────────────────────────────────

/**
 * outlet metafield or lifecycle label → "used"; everything else → "new".
 * Previously always returned "new", missing outlet / showroom-floor products.
 */
function resolveCondition(canonical: CanonicalProduct): string {
  if (canonical.isOutlet || canonical.customLabels.custom_label_0 === "outlet") {
    return "used";
  }
  return "new";
}

// ── Availability mapping ──────────────────────────────────────────────────────

function mapAvailability(status: CanonicalProduct["availability"]): string {
  // The standard catalog is orderability-based, not Shopify physical stock.
  // The separate Eupen showroom catalog remains stock-based.
  return status === "discontinued" ? "discontinued" : "in stock";
}

// ── Price formatting ──────────────────────────────────────────────────────────

function formatPrice(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

// ── Fix 8: return_policy_info ─────────────────────────────────────────────────

/**
 * Build Meta return_policy_info from the product's returnClass and the returns config.
 *
 * Format: {"is_final_sale":"false","return_policy_days":"14"}
 *
 * - returnable classes (e.g. standard) → is_final_sale: false, days from config
 * - non-returnable classes (made_to_order, exhibition, customized) → is_final_sale: true
 *
 * This field overrides the shop's default return window per-product, which
 * is important for Belgian consumer-law compliance and Meta Shop badge eligibility.
 */
function buildReturnPolicyInfo(canonical: CanonicalProduct, config: AppConfig): string {
  const returnClass = canonical.returnClass ?? config.returns.default_class;
  const policy = config.returns.classes[returnClass];

  if (!policy || policy.returnable === false) {
    return '{"is_final_sale": "true", "return_policy_days": "0"}';
  }
  const days = policy.days ?? 14;
  return `{"is_final_sale": "false", "return_policy_days": "${days}"}`;
}

// ── Fix 14: product_type hierarchy ────────────────────────────────────────────

/**
 * Prefer metaProductCategory when it has a ">" separator (e.g. "Furniture > Sofas & Couches").
 * The hierarchy improves Advantage+ catalog targeting precision.
 */
function buildMetaProductType(canonical: CanonicalProduct): string {
  if (canonical.metaProductCategory?.includes(">")) {
    return canonical.metaProductCategory.slice(0, 750);
  }
  return canonical.productType ?? "";
}

// ── Product ID ────────────────────────────────────────────────────────────────

/**
 * Meta product ID: {variantId}_{market}
 * e.g. uuid-abc-123_BE_FR — stable across syncs, unique per variant+market.
 */
export function buildMetaProductId(canonical: CanonicalProduct): string {
  return `${canonical.variantId}_${canonical.market}`;
}

// ── Main mapper ───────────────────────────────────────────────────────────────

/**
 * Map a CanonicalProduct to all three Meta feed layers.
 * Returns null if the product has no primary image.
 */
export function mapToMeta(
  canonical: CanonicalProduct,
  config: AppConfig,
): MetaMapped | null {
  if (!canonical.primaryImage) return null;

  const market = config.markets.markets[canonical.market];
  if (!market) return null;

  const id = buildMetaProductId(canonical);
  const country = market.country;
  const language = market.language;

  const additionalImages = canonical.additionalImages
    .filter((img) => img.url !== canonical.primaryImage?.url)
    .slice(0, 10)
    .map((img) => img.url)
    .join(",");

  const base: MetaBaseRow = {
    id,
    item_group_id: canonical.itemGroupId,
    gtin: canonical.gtin ?? "",
    mpn: canonical.mpn ?? "",
    brand: canonical.brand.slice(0, 200),
    // Fix 4: was always "new" — now correctly "used" for outlet / showroom-floor products
    condition: resolveCondition(canonical),
    image_link: canonical.primaryImage.url,
    additional_image_link: additionalImages,
    lifestyle_image_link: canonical.lifestyleImage?.url ?? "",
    // Fix 3: was canonical.googleProductCategory — Meta prefers its own taxonomy string.
    // metaProductCategory is sourced from variant.metafieldMetaCategory → categories.yaml.
    google_product_category: canonical.metaProductCategory ?? canonical.googleProductCategory ?? "",
    product_type: buildMetaProductType(canonical), // Fix 14
    color: canonical.color.join(",").slice(0, 200),
    material: canonical.material.join(",").slice(0, 200),
    age_group: "adult",
    gender: "unisex",
    // Fix 8: per-product return policy derived from returnClass
    return_policy_info: buildReturnPolicyInfo(canonical, config),
    custom_label_0: canonical.customLabels.custom_label_0,
    custom_label_1: canonical.customLabels.custom_label_1,
    custom_label_2: canonical.customLabels.custom_label_2,
    custom_label_3: canonical.customLabels.custom_label_3,
    custom_label_4: canonical.customLabels.custom_label_4,
  };

  const language_row: MetaLanguageRow = {
    id,
    title: canonical.title.slice(0, 500),
    description: buildFeedDescription(canonical),
    link: canonical.productUrl,
  };

  const country_row: MetaCountryRow = {
    id,
    price: formatPrice(canonical.price.amount, canonical.price.currency),
    sale_price: canonical.salePrice
      ? formatPrice(canonical.salePrice.amount, canonical.salePrice.currency)
      : "",
    // Fix 10: sale_price_effective_date requires Shopify price-rule date range.
    // Not currently synced — add to sync-prices phase when available.
    sale_price_effective_date: "",
    availability: mapAvailability(canonical.availability),
    shipping: buildMarketShipping(canonical, config),
  };

  return { id, language, country, base, language_row, country_row };
}
