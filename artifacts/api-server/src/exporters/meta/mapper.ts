/**
 * Meta Catalog Feed Mapper
 *
 * Converts a CanonicalProduct into the Meta localized catalog architecture:
 *   BASE    — identity, classification, images (language-agnostic)
 *   LANGUAGE — title, description, link (per language: fr, de)
 *   COUNTRY  — price, availability (per market country: BE, FR, DE, AT)
 *
 * Spec reference: §1329-1362 (Meta architecture), §571-635 (canonical model).
 */

import type { CanonicalProduct } from "../../canonical/types";
import type { AppConfig } from "../../config/schemas";

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

/** Country/market override row — price and availability. */
export interface MetaCountryRow {
  id: string;
  price: string;
  sale_price: string;
  sale_price_effective_date: string;
  availability: string;
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
];

// ── Availability mapping ──────────────────────────────────────────────────────

function mapAvailability(status: CanonicalProduct["availability"]): string {
  switch (status) {
    case "in_stock":
    case "low_stock":
      return "in stock";
    case "backorder":
      return "available for order";
    case "out_of_stock":
      return "out of stock";
    case "discontinued":
      return "discontinued";
    default:
      return "out of stock";
  }
}

// ── Price formatting ──────────────────────────────────────────────────────────

function formatPrice(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

// ── Product ID ────────────────────────────────────────────────────────────────

/**
 * Meta product ID.
 *
 * Format: {variantId}_{market}
 * e.g.   uuid-abc-123_BE_FR
 *
 * Stable across syncs; unique per variant+market combination.
 */
export function buildMetaProductId(canonical: CanonicalProduct): string {
  return `${canonical.variantId}_${canonical.market}`;
}

// ── Main mapper ───────────────────────────────────────────────────────────────

/**
 * Map a CanonicalProduct to all three Meta feed layers.
 * Returns null if the product cannot be included (no primary image).
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
    .slice(0, 20)
    .map((img) => img.url)
    .join(",");

  const base: MetaBaseRow = {
    id,
    item_group_id: canonical.itemGroupId,
    gtin: canonical.gtin ?? "",
    mpn: canonical.mpn ?? "",
    brand: canonical.brand.slice(0, 200),
    condition: "new",
    image_link: canonical.primaryImage.url,
    additional_image_link: additionalImages,
    lifestyle_image_link: canonical.lifestyleImage?.url ?? "",
    google_product_category: canonical.googleProductCategory ?? "",
    product_type: canonical.productType ?? "",
    color: canonical.color.join(",").slice(0, 200),
    material: canonical.material.join(",").slice(0, 200),
    age_group: "adult",
    gender: "unisex",
    custom_label_0: canonical.customLabels.custom_label_0,
    custom_label_1: canonical.customLabels.custom_label_1,
    custom_label_2: canonical.customLabels.custom_label_2,
    custom_label_3: canonical.customLabels.custom_label_3,
    custom_label_4: canonical.customLabels.custom_label_4,
  };

  const language_row: MetaLanguageRow = {
    id,
    title: canonical.title.slice(0, 500),
    description: (canonical.description || canonical.title).slice(0, 9999),
    link: canonical.productUrl,
  };

  const country_row: MetaCountryRow = {
    id,
    price: formatPrice(canonical.price.amount, canonical.price.currency),
    sale_price: canonical.salePrice
      ? formatPrice(canonical.salePrice.amount, canonical.salePrice.currency)
      : "",
    sale_price_effective_date: "",
    availability: mapAvailability(canonical.availability),
  };

  return { id, language, country, base, language_row, country_row };
}
