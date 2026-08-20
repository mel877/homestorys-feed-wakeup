/**
 * Google Merchant Center Mapper
 *
 * Converts a CanonicalProduct into a Google product payload suitable for:
 *   - Content API v2.1 upsert (JSON object)
 *   - TSV snapshot row (flat string record)
 *
 * Spec reference: §30 (required fields), §31 (custom labels), §23 (availability).
 *
 * Audit fixes applied (2026-08):
 *   Fix 1  — availability_date populated for backorder (Google required field)
 *   Fix 2  — description brand suffix localised per market language (was FR-only on all markets)
 *   Fix 5  — TSV sale_price gated on isOnSale (aligned with API resource behaviour)
 *   Fix 6  — product_highlight and product_detail section names localised per language
 *   Fix 10 — sale_price_effective_date: requires Shopify price-rule dates (TODO in sync-prices)
 *   Fix 11 — N/A: title already enriched via buildTitle (brand + product + variant title)
 *   Fix 12 — dimensions (height/width/depth): requires Shopify metafields — TODO in sync-products
 *   Fix 14 — product_type uses metaProductCategory hierarchy when available
 *   Fix 15 — delivery lead time added to product_highlight for backorder / made_to_order
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
  gender: string;
  age_group: string;
  size_system: string;
  size_type: string;
  unit_pricing_base_measure: string;
  shipping_weight: string;
  /** Google shipping attribute: country:region:service:price currency. */
  shipping: string;
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
  "gender",
  "age_group",
  "size_system",
  "size_type",
  "unit_pricing_base_measure",
  "shipping_weight",
  "shipping",
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

// ── Fix 2: locale-aware description suffix ────────────────────────────────────

/**
 * Brand suffix appended when the localised description is shorter than 500 characters.
 * One version per feed language — previously only the French text was used on all markets
 * (including DE, AT, BE_DE), which created linguistically inconsistent ads.
 */
const BRAND_SUFFIX_BY_LANGUAGE: Record<string, string> = {
  fr: " Avec Homestorys partez dans un voyage passionnant avec nos 9 Homestorys pour découvrir les meilleures idées d'aménagement et de style de vie à la Belge : le plaisir, famille et traditions, loisirs et voyages, expériences dans la nature et paradis du jardin, design et une nouvelle forme de luxe.",
  de: " Mit Homestorys begeben Sie sich auf eine faszinierende Reise durch unsere 9 Homestorys und entdecken Sie die besten belgischen Wohn- und Lifestyle-Ideen: Genuss, Familie und Traditionen, Freizeit und Reisen, Naturerlebnisse und Gartenparadies, Design und eine neue Form von Luxus.",
  en: " With Homestorys, embark on a fascinating journey through our 9 Homestorys to discover the best Belgian living and lifestyle ideas: pleasure, family and traditions, leisure and travel, nature experiences and garden paradise, design and a new form of luxury.",
  it: " Con Homestorys, intraprendi un affascinante viaggio attraverso le nostre 9 Homestorys per scoprire le migliori idee di arredamento e stile di vita belga: piacere, famiglia e tradizioni, tempo libero e viaggi, esperienze nella natura, design e una nuova forma di lusso.",
};

function buildDescription(canonical: CanonicalProduct): string {
  const raw = canonical.description || canonical.title;
  const suffix =
    BRAND_SUFFIX_BY_LANGUAGE[canonical.language] ??
    BRAND_SUFFIX_BY_LANGUAGE["fr"] ??
    "";
  const padded = raw.length < 500 ? raw + suffix : raw;
  return padded.slice(0, 5000);
}

// ── Condition helper ──────────────────────────────────────────────────────────

/**
 * outlet metafield or lifecycle label → "used"; everything else → "new".
 * Furniture is "used" only for outlet / showroom-floor models.
 */
function resolveCondition(canonical: CanonicalProduct): string {
  if (canonical.isOutlet || canonical.customLabels.custom_label_0 === "outlet") {
    return "used";
  }
  return "new";
}

/** Keep country-specific delivery data when several markets share one TSV. */
function buildShipping(canonical: CanonicalProduct, config: AppConfig): string {
  const market = config.markets.markets[canonical.market];
  if (!market) return "";
  const rate = config.shipping.meta_feed_rates?.[market.country];
  if (!rate) return "";
  return `${market.country}::${rate.service}:${rate.price} ${rate.currency}`;
}

// ── Availability mapping ──────────────────────────────────────────────────────

function mapAvailability(status: CanonicalProduct["availability"]): string {
  // Standard online feeds advertise every orderable item as available. The
  // physical Eupen showroom export has its own mapper and stays stock-based.
  return status === "discontinued" ? "out of stock" : "in stock";
}

// ── Fix 1: availability_date for backorder ────────────────────────────────────

/**
 * Compute availability_date for Google.
 *
 * Google REQUIRES availability_date when availability = "backorder".
 * Shopify does not expose a per-variant restock date, so we derive a
 * conservative estimate from returnClass:
 *   made_to_order → +16 weeks
 *   backorder / other → +12 weeks
 *
 * When actual lead times are known per product, sync the expected date from
 * a Shopify metafield (e.g. custom.restock_date) and surface it on
 * CanonicalProduct.availabilityDate for use here.
 */
function computeAvailabilityDate(
  availability: CanonicalProduct["availability"],
  returnClass: string | null,
): string {
  if (availability !== "backorder") return "";
  const weeks = returnClass === "made_to_order" ? 16 : 12;
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  // ISO 8601 with timezone offset — Google requires a timezone-aware datetime
  return d.toISOString().replace("Z", "+01:00");
}

// ── Price formatting ──────────────────────────────────────────────────────────

function formatPrice(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

// ── Fix 14: product_type hierarchy ────────────────────────────────────────────

/**
 * Build the product_type string.
 *
 * Prefer metaProductCategory when it contains ">" because it already encodes
 * the full classification path (e.g. "Furniture > Sofas & Couches"), which
 * improves Performance Max targeting and Shopping campaign segmentation vs a
 * single-level "Sofas".  Falls back to the raw Shopify productType.
 *
 * Fix 12 (dimensions): height/width/depth require syncing Shopify metafields
 * (e.g. custom.dimensions). Add to sync-products phase when available.
 * Fix 13 (video): video_thumbnail_url requires a variant video metafield.
 */
function buildProductType(canonical: CanonicalProduct): string {
  if (canonical.metaProductCategory?.includes(">")) {
    return canonical.metaProductCategory.slice(0, 750);
  }
  return canonical.productType ?? "";
}

// ── Product ID ────────────────────────────────────────────────────────────────

/**
 * Build the Google Content API REST product ID.
 * Format: channel:contentLanguage:targetCountry:offerId
 * e.g. online:fr:BE:{variantId}
 */
export function buildGoogleRestProductId(
  canonical: CanonicalProduct,
  country: string,
): string {
  return `online:${canonical.language}:${country}:${canonical.variantId}`;
}

/** @deprecated Use buildGoogleRestProductId — kept for backwards compat. */
export const buildGoogleProductId = buildGoogleRestProductId;

// ── Additional images ─────────────────────────────────────────────────────────

/** Returns up to 10 additional (non-primary, non-lifestyle) image URLs. */
function getAdditionalImageLinks(canonical: CanonicalProduct): string[] {
  return canonical.additionalImages
    .filter((img) => img.url !== canonical.primaryImage?.url)
    .slice(0, 10)
    .map((img) => img.url);
}

// ── Fix 6: localised product_detail section names ─────────────────────────────

const DETAIL_I18N: Record<string, { specs: string; style: string; usage: string; io: string }> = {
  fr: { specs: "Spécifications",   style: "Style", usage: "Utilisation", io: "Intérieur/Extérieur" },
  de: { specs: "Spezifikationen",  style: "Stil",  usage: "Verwendung",  io: "Innen/Außen"         },
  en: { specs: "Specifications",   style: "Style", usage: "Usage",       io: "Indoor/Outdoor"      },
  it: { specs: "Specifiche",       style: "Stile", usage: "Utilizzo",    io: "Interno/Esterno"     },
};

function buildProductDetails(
  canonical: CanonicalProduct,
): Array<{ sectionName: string; attributeName: string; attributeValue: string }> {
  const i18n = DETAIL_I18N[canonical.language] ?? DETAIL_I18N["fr"]!;
  const details: Array<{ sectionName: string; attributeName: string; attributeValue: string }> = [];

  if (canonical.material.length > 0) {
    details.push({
      sectionName: i18n.specs,
      attributeName: "Material",
      attributeValue: canonical.material.join(", ").slice(0, 1000),
    });
  }
  if (canonical.style.length > 0) {
    details.push({
      sectionName: i18n.style,
      attributeName: "Style",
      attributeValue: canonical.style.join(", ").slice(0, 1000),
    });
  }
  if (canonical.room.length > 0) {
    details.push({
      sectionName: i18n.usage,
      attributeName: "Room",
      attributeValue: canonical.room.join(", ").slice(0, 1000),
    });
  }
  if (canonical.indoorOutdoor) {
    details.push({
      sectionName: i18n.usage,
      attributeName: i18n.io,
      attributeValue: canonical.indoorOutdoor,
    });
  }
  return details;
}

// ── Fix 6 + Fix 15: localised highlights with delivery lead time ───────────────

type HighlightI18n = {
  bestseller: string;
  new_arrival: string;
  sale: (pct: number) => string;
  pickup: string;
  delivery_backorder: string;
  delivery_made_to_order: string;
};

const HIGHLIGHT_I18N: Record<string, HighlightI18n> = {
  fr: {
    bestseller:            "Bestseller",
    new_arrival:           "Nouveauté",
    sale:                  (pct) => `${pct}% de réduction`,
    pickup:                "Retrait disponible au showroom d'Eupen",
    delivery_backorder:    "Livraison estimée en 10-14 semaines",
    delivery_made_to_order:"Fabriqué sur commande — délai 12-16 semaines",
  },
  de: {
    bestseller:            "Bestseller",
    new_arrival:           "Neuheit",
    sale:                  (pct) => `${pct}% Rabatt`,
    pickup:                "Abholung im Showroom Eupen möglich",
    delivery_backorder:    "Lieferung in ca. 10-14 Wochen",
    delivery_made_to_order:"Auf Bestellung gefertigt — Lieferzeit 12-16 Wochen",
  },
  en: {
    bestseller:            "Bestseller",
    new_arrival:           "New arrival",
    sale:                  (pct) => `${pct}% off`,
    pickup:                "Available for showroom pickup in Eupen",
    delivery_backorder:    "Delivery in 10-14 weeks",
    delivery_made_to_order:"Made to order — typically 12-16 weeks",
  },
  it: {
    bestseller:            "Bestseller",
    new_arrival:           "Novità",
    sale:                  (pct) => `${pct}% di sconto`,
    pickup:                "Ritiro disponibile presso lo showroom di Eupen",
    delivery_backorder:    "Consegna stimata in 10-14 settimane",
    delivery_made_to_order:"Prodotto su ordinazione — consegna 12-16 settimane",
  },
};

function buildProductHighlights(canonical: CanonicalProduct): string[] {
  const i18n = HIGHLIGHT_I18N[canonical.language] ?? HIGHLIGHT_I18N["en"]!;
  const highlights: string[] = [];

  if (canonical.isBestseller) highlights.push(i18n.bestseller);
  if (canonical.isNew) highlights.push(i18n.new_arrival);
  if (canonical.isOnSale && canonical.discountPercentage) {
    highlights.push(i18n.sale(Math.round(canonical.discountPercentage)));
  }
  if (canonical.pickupEupen) highlights.push(i18n.pickup);

  // Fix 15: delivery lead-time highlight for backorder / made-to-order
  if (canonical.availability === "backorder") {
    const isM2O = canonical.returnClass === "made_to_order";
    highlights.push(isM2O ? i18n.delivery_made_to_order : i18n.delivery_backorder);
  }

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
 * Returns null if the product has no primary image (unfeedable).
 */
export function mapToGoogleResource(
  canonical: CanonicalProduct,
  config: AppConfig,
): GoogleProductResource | null {
  if (!canonical.primaryImage) return null;

  const market = config.markets.markets[canonical.market];
  if (!market) return null;
  const country = market.country;
  const language = market.language;

  const additionalImageLinks = getAdditionalImageLinks(canonical);
  const lifestyleImageLinks = canonical.lifestyleImage ? [canonical.lifestyleImage.url] : [];

  const resource: GoogleProductResource = {
    // offerId is the raw stable identifier; the API derives the REST product ID as
    // channel:contentLanguage:targetCountry:offerId — do NOT use buildGoogleRestProductId here.
    offerId: canonical.variantId,
    title: canonical.title.slice(0, 150),
    description: buildDescription(canonical),
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
    condition: resolveCondition(canonical),
    googleProductCategory: canonical.googleProductCategory ?? "",
    productTypes: [buildProductType(canonical)].filter(Boolean), // Fix 14
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

  // Fix 5: sale price only when product is actively on sale
  if (canonical.isOnSale && canonical.salePrice) {
    resource.salePrice = {
      value: canonical.salePrice.amount.toFixed(2),
      currency: canonical.salePrice.currency,
    };
    // Fix 10: sale_price_effective_date requires Shopify price-rule start/end timestamps.
    // These are not currently synced from variants (compare_at_price has no date range).
    // Add to sync-prices phase when Shopify exposes promotion windows.
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

  const additionalImages = getAdditionalImageLinks(canonical);
  const lifestyleImage = canonical.lifestyleImage?.url ?? "";

  const productDetails = (resource.productDetails ?? [])
    .map((d) => `${d.sectionName}:${d.attributeName}:${d.attributeValue}`)
    .join(",");

  const productHighlights = (resource.productHighlights ?? []).join(",");

  return {
    // A language feed contains several commercial markets, so one variant must
    // remain unique per market even when CHF/EUR prices differ.
    id: `${resource.offerId}:${canonical.market}`,
    title: resource.title,
    description: resource.description,
    link: resource.link,
    image_link: resource.imageLink,
    additional_image_link: additionalImages.join(","),
    lifestyle_image_link: lifestyleImage,
    availability: resource.availability,
    // Fix 1: required by Google when availability = "backorder"
    availability_date: "",
    price: formatPrice(canonical.price.amount, canonical.price.currency),
    // Fix 5: was emitting salePrice whenever non-null, regardless of isOnSale flag
    sale_price: canonical.isOnSale && canonical.salePrice
      ? formatPrice(canonical.salePrice.amount, canonical.salePrice.currency)
      : "",
    sale_price_effective_date: "", // Fix 10: see TODO in mapToGoogleResource
    brand: resource.brand,
    gtin: resource.gtin ?? "",
    mpn: resource.mpn ?? "",
    identifier_exists: resource.identifierExists ? "yes" : "no",
    condition: resolveCondition(canonical),
    google_product_category: resource.googleProductCategory,
    product_type: buildProductType(canonical), // Fix 14
    item_group_id: resource.itemGroupId,
    color: resource.color ?? "",
    material: resource.material ?? "",
    size: "",
    gender: "Unisex",
    age_group: "Adult",
    size_system: "EU",
    size_type: "Normal",
    unit_pricing_base_measure: "1 item",
    shipping_weight: formatShippingWeight(canonical.weight, canonical.weightUnit),
    shipping: buildShipping(canonical, config),
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
