/**
 * Google Merchant Center Mapper
 *
 * Converts a CanonicalProduct into a Google product payload suitable for:
 *   - Content API v2.1 upsert (JSON object)
 *   - TSV snapshot row (flat string record)
 *
 * Spec reference: §30 (required fields), §31 (custom labels), §23 (availability).
 */

import type { CanonicalProduct } from "../../canonical/types";
import type { AppConfig } from "../../config/schemas";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A row in the Google TSV snapshot. Every field is a string (TSV requirement).
 * Fields are a superset of what Content API accepts.
 */
export interface GoogleFeedRow {
  id: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  additional_image_link: string;
  lifestyle_image_link: string;
  availability: string;
  availability_date: string;
  price: string;
  sale_price: string;
  sale_price_effective_date: string;
  brand: string;
  gtin: string;
  mpn: string;
  identifier_exists: string;
  condition: string;
  google_product_category: string;
  product_type: string;
  item_group_id: string;
  color: string;
  material: string;
  size: string;
  shipping_weight: string;
  custom_label_0: string;
  custom_label_1: string;
  custom_label_2: string;
  custom_label_3: string;
  custom_label_4: string;
  product_detail: string;
  product_highlight: string;
}

/** All column names in TSV header order. */
export const GOOGLE_TSV_HEADERS: (keyof GoogleFeedRow)[] = [
  "id",
  "title",
  "description",
  "link",
  "image_link",
  "additional_image_link",
  "lifestyle_image_link",
  "availability",
  "availability_date",
  "price",
  "sale_price",
  "sale_price_effective_date",
  "brand",
  "gtin",
  "mpn",
  "identifier_exists",
  "condition",
  "google_product_category",
  "product_type",
  "item_group_id",
  "color",
  "material",
  "size",
  "shipping_weight",
  "custom_label_0",
  "custom_label_1",
  "custom_label_2",
  "custom_label_3",
  "custom_label_4",
  "product_detail",
  "product_highlight",
];

/**
 * Google Content API v2.1 product resource shape (partial).
 * Used for Merchant API upserts.
 */
export interface GoogleProductResource {
  offerId: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImageLinks: string[];
  lifestyleImageLinks: string[];
  availability: string;
  price: { value: string; currency: string };
  salePrice?: { value: string; currency: string };
  salePriceEffectiveDate?: string;
  brand: string;
  gtin?: string;
  mpn?: string;
  identifierExists: boolean;
  condition: string;
  googleProductCategory: string;
  productTypes: string[];
  itemGroupId: string;
  color?: string;
  material?: string;
  shippingWeight?: { value: number; unit: string };
  customLabel0?: string;
  customLabel1?: string;
  customLabel2?: string;
  customLabel3?: string;
  customLabel4?: string;
  productDetails?: Array<{ sectionName: string; attributeName: string; attributeValue: string }>;
  productHighlights?: string[];
  targetCountry: string;
  contentLanguage: string;
  channel: "online";
}

// ── Availability mapping ──────────────────────────────────────────────────────

function mapAvailability(
  status: CanonicalProduct["availability"],
): string {
  switch (status) {
    case "in_stock":
    case "low_stock":
      return "in stock";
    case "backorder":
      return "backorder";
    case "out_of_stock":
      return "out of stock";
    case "discontinued":
      return "out of stock";
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
 * Build the Google Content API REST product ID.
 *
 * This is the full identifier that the Merchant Center API assigns to an
 * uploaded product and that must be used for delete and local-inventory
 * operations. Format: channel:contentLanguage:targetCountry:offerId
 *
 * e.g. online:fr:BE:{variantId}
 *
 * NOTE: This is NOT the offerId field in a product resource.
 * The offerId must be just the raw stable identifier (variantId).
 * The REST product ID is derived by the API: channel:language:country:offerId.
 */
export function buildGoogleRestProductId(
  canonical: CanonicalProduct,
  country: string,
): string {
  return `online:${canonical.language}:${country}:${canonical.variantId}`;
}

/** @deprecated Use buildGoogleRestProductId — kept for backwards compat during migration. */
export const buildGoogleProductId = buildGoogleRestProductId;

// ── Additional images ─────────────────────────────────────────────────────────

/** Returns up to 10 additional (non-primary, non-lifestyle) image URLs. */
function getAdditionalImageLinks(canonical: CanonicalProduct): string[] {
  return canonical.additionalImages
    .filter((img) => img.url !== canonical.primaryImage?.url)
    .slice(0, 10)
    .map((img) => img.url);
}

// ── Product details ──────────────────────────────────────────────────────────

function buildProductDetails(
  canonical: CanonicalProduct,
): Array<{ sectionName: string; attributeName: string; attributeValue: string }> {
  const details: Array<{ sectionName: string; attributeName: string; attributeValue: string }> = [];

  if (canonical.material.length > 0) {
    details.push({
      sectionName: "Specifications",
      attributeName: "Material",
      attributeValue: canonical.material.join(", ").slice(0, 1000),
    });
  }
  if (canonical.style.length > 0) {
    details.push({
      sectionName: "Style",
      attributeName: "Style",
      attributeValue: canonical.style.join(", ").slice(0, 1000),
    });
  }
  if (canonical.room.length > 0) {
    details.push({
      sectionName: "Usage",
      attributeName: "Room",
      attributeValue: canonical.room.join(", ").slice(0, 1000),
    });
  }
  if (canonical.indoorOutdoor) {
    details.push({
      sectionName: "Usage",
      attributeName: "Indoor/Outdoor",
      attributeValue: canonical.indoorOutdoor,
    });
  }
  return details;
}

// ── Product highlights ────────────────────────────────────────────────────────

function buildProductHighlights(canonical: CanonicalProduct): string[] {
  const highlights: string[] = [];

  if (canonical.isBestseller) highlights.push("Bestseller");
  if (canonical.isNew) highlights.push("New arrival");
  if (canonical.isOnSale && canonical.discountPercentage) {
    highlights.push(`${Math.round(canonical.discountPercentage)}% off`);
  }
  if (canonical.pickupEupen) highlights.push("Available for showroom pickup in Eupen");
  if (canonical.material.length > 0) {
    highlights.push(canonical.material.slice(0, 3).join(", "));
  }

  return highlights.slice(0, 10).map((h) => h.slice(0, 150));
}

// ── Shipping weight ───────────────────────────────────────────────────────────

function formatShippingWeight(
  weight: number | null,
  unit: string | null,
): string {
  if (!weight) return "";
  const u = unit?.toLowerCase() ?? "kg";
  const safeUnit = ["kg", "g", "lb", "oz"].includes(u) ? u : "kg";
  return `${weight} ${safeUnit}`;
}

// ── Main mapper ───────────────────────────────────────────────────────────────

/**
 * Map a CanonicalProduct to a Google Content API product resource.
 * Returns null if the product has exclusion reasons that make it unfeedable.
 */
export function mapToGoogleResource(
  canonical: CanonicalProduct,
  config: AppConfig,
): GoogleProductResource | null {
  // Hard exclusions: no image, discontinued, missing required fields
  if (!canonical.primaryImage) return null;

  const market = config.markets.markets[canonical.market];
  if (!market) return null;
  const country = market.country;
  const language = market.language;

  const additionalImageLinks = getAdditionalImageLinks(canonical);
  const lifestyleImageLinks = canonical.lifestyleImage ? [canonical.lifestyleImage.url] : [];

  const resource: GoogleProductResource = {
    // offerId is the raw stable identifier. The API derives the REST product ID
    // as channel:contentLanguage:targetCountry:offerId automatically.
    // Do NOT use buildGoogleRestProductId here — that would double the prefix.
    offerId: canonical.variantId,
    title: canonical.title.slice(0, 150),
    description: canonical.description.slice(0, 5000) || canonical.title,
    link: canonical.productUrl,
    imageLink: canonical.primaryImage.url,
    additionalImageLinks,
    lifestyleImageLinks,
    availability: mapAvailability(canonical.availability),
    price: {
      value: canonical.price.amount.toFixed(2),
      currency: canonical.price.currency,
    },
    brand: canonical.brand.slice(0, 70),
    identifierExists: canonical.identifierExists,
    condition: "new",
    googleProductCategory: canonical.googleProductCategory ?? "",
    productTypes: canonical.productType ? [canonical.productType] : [],
    itemGroupId: canonical.itemGroupId,
    targetCountry: country,
    contentLanguage: language,
    channel: "online",
    customLabel0: canonical.customLabels.custom_label_0,
    customLabel1: canonical.customLabels.custom_label_1,
    customLabel2: canonical.customLabels.custom_label_2,
    customLabel3: canonical.customLabels.custom_label_3,
    customLabel4: canonical.customLabels.custom_label_4,
  };

  if (canonical.gtin) resource.gtin = canonical.gtin;
  if (canonical.mpn) resource.mpn = canonical.mpn.slice(0, 70);
  if (canonical.color.length > 0) resource.color = canonical.color.join("/").slice(0, 100);
  if (canonical.material.length > 0) resource.material = canonical.material.join("/").slice(0, 200);

  if (canonical.isOnSale && canonical.salePrice) {
    resource.salePrice = {
      value: canonical.salePrice.amount.toFixed(2),
      currency: canonical.salePrice.currency,
    };
  }

  if (canonical.weight && canonical.weightUnit) {
    resource.shippingWeight = { value: canonical.weight, unit: canonical.weightUnit };
  }

  const productDetails = buildProductDetails(canonical);
  if (productDetails.length > 0) resource.productDetails = productDetails;

  const productHighlights = buildProductHighlights(canonical);
  if (productHighlights.length > 0) resource.productHighlights = productHighlights;

  return resource;
}

/**
 * Map a CanonicalProduct to a flat TSV row for snapshot files.
 * Returns null if the product cannot be included.
 */
export function mapToGoogleRow(
  canonical: CanonicalProduct,
  config: AppConfig,
): GoogleFeedRow | null {
  const resource = mapToGoogleResource(canonical, config);
  if (!resource) return null;

  const market = config.markets.markets[canonical.market]!;

  const additionalImages = getAdditionalImageLinks(canonical);
  const lifestyleImage = canonical.lifestyleImage?.url ?? "";

  const productDetails = (resource.productDetails ?? [])
    .map((d) => `${d.sectionName}:${d.attributeName}:${d.attributeValue}`)
    .join(",");

  const productHighlights = (resource.productHighlights ?? []).join(",");

  return {
    id: resource.offerId,
    title: resource.title,
    description: resource.description,
    link: resource.link,
    image_link: resource.imageLink,
    additional_image_link: additionalImages.join(","),
    lifestyle_image_link: lifestyleImage,
    availability: resource.availability,
    availability_date: "",
    price: formatPrice(canonical.price.amount, canonical.price.currency),
    sale_price: canonical.salePrice
      ? formatPrice(canonical.salePrice.amount, canonical.salePrice.currency)
      : "",
    sale_price_effective_date: "",
    brand: resource.brand,
    gtin: resource.gtin ?? "",
    mpn: resource.mpn ?? "",
    identifier_exists: resource.identifierExists ? "yes" : "no",
    condition: "new",
    google_product_category: resource.googleProductCategory,
    product_type: canonical.productType ?? "",
    item_group_id: resource.itemGroupId,
    color: resource.color ?? "",
    material: resource.material ?? "",
    size: "",
    shipping_weight: formatShippingWeight(canonical.weight, canonical.weightUnit),
    custom_label_0: canonical.customLabels.custom_label_0,
    custom_label_1: canonical.customLabels.custom_label_1,
    custom_label_2: canonical.customLabels.custom_label_2,
    custom_label_3: canonical.customLabels.custom_label_3,
    custom_label_4: canonical.customLabels.custom_label_4,
    product_detail: productDetails,
    product_highlight: productHighlights,
  };
}

// ── TSV serialization ─────────────────────────────────────────────────────────

/** Escape a TSV cell value (tabs and newlines must be escaped). */
function escapeTsv(value: string): string {
  return value.replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "");
}

/** Serialize a row to a TSV line. */
export function rowToTsvLine(row: GoogleFeedRow): string {
  return GOOGLE_TSV_HEADERS.map((h) => escapeTsv(row[h] ?? "")).join("\t");
}

/** Build a complete TSV file string from rows. */
export function buildGoogleTsv(rows: GoogleFeedRow[]): string {
  const header = GOOGLE_TSV_HEADERS.join("\t");
  const lines = rows.map(rowToTsvLine);
  return [header, ...lines].join("\n") + "\n";
}
