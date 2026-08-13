/**
 * Canonical Product Model — Section 10 of the spec.
 *
 * Every sellable Shopify variant becomes one CanonicalProduct per market+language.
 * This is the single source of truth from which Google and Meta exporters read.
 */

// ── Scalar helpers ──────────────────────────────────────────────────────────

/** A monetary value with currency. Always from Shopify Markets — never converted. */
export interface Money {
  amount: number; // always positive
  currency: string; // ISO 4217 e.g. "EUR"
  formatted: string; // "€299.00"
}

/** A classified image ready for channel export. */
export interface ImageAsset {
  url: string;
  urlHash: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  imageType: ImageType;
  position: number;
}

/** Image classification from deterministic sharp analysis. */
export type ImageType =
  | "lifestyle"
  | "packshot_white"
  | "packshot_solid"
  | "packshot_transparent"
  | "detail"
  | "invalid"
  | "unknown";

/** Reason a variant is excluded from a channel/market feed. */
export type ExclusionReason =
  | "MISSING_PRICE"
  | "INVALID_PRICE"
  | "NO_VALID_IMAGE"
  | "DISCONTINUED"
  | "UNPUBLISHED"
  | "INVALID_MARKET"
  | "MISSING_REQUIRED_TRANSLATION"
  | "MISSING_REQUIRED_IDENTIFIER"
  | "POLICY_EXCLUSION";

/** Availability states per spec section 23. */
export type AvailabilityStatus =
  | "in_stock"
  | "low_stock"
  | "backorder"
  | "out_of_stock"
  | "discontinued";

/** Discount bucket per spec section 15. */
export type DiscountBucket =
  | "none"
  | "1_10"
  | "11_20"
  | "21_30"
  | "31_50"
  | "51_70"
  | "70_plus";

/** Bestseller class per spec section 18. */
export type BestsellerClass = "bestseller" | "high" | "medium" | "low";

// ── Main canonical type ──────────────────────────────────────────────────────

/**
 * Canonical product: one per (variant × market × language).
 * All fields are sourced directly from Shopify + config — never invented.
 */
export interface CanonicalProduct {
  // ── Identity ──────────────────────────────────────────────────────────────
  id: string; // variantDbId (stable UUID)
  productId: string; // product DB UUID
  variantId: string; // variant DB UUID
  itemGroupId: string; // product Shopify GID (groups variants)

  sku: string | null;
  gtin: string | null; // validated EAN/UPC; null if absent or invalid
  mpn: string | null; // from feed.mpn metafield
  identifierExists: boolean; // true if gtin or mpn is present and valid

  brand: string; // vendor → alias map → canonical brand name
  vendor: string | null; // raw Shopify vendor

  // ── Locale ────────────────────────────────────────────────────────────────
  language: "fr" | "de" | "en" | "it";
  market: string; // BE_FR | BE_DE | FR | DE | AT

  // ── Content ───────────────────────────────────────────────────────────────
  title: string; // brand + product name + variant title (sanitized)
  description: string; // Shopify description HTML → sanitized plain text
  productType: string | null;
  collections: string[];

  // ── Classification ────────────────────────────────────────────────────────
  googleProductCategory: string | null; // Google taxonomy ID
  metaProductCategory: string | null; // Meta taxonomy string

  // ── Attributes ────────────────────────────────────────────────────────────
  material: string[];
  color: string[];
  style: string[];
  room: string[];
  indoorOutdoor: "indoor" | "outdoor" | "both" | null;

  // ── Pricing ───────────────────────────────────────────────────────────────
  price: Money;
  compareAtPrice: Money | null;
  salePrice: Money | null; // alias for price when isOnSale, for explicit feed field

  isOnSale: boolean;
  discountPercentage: number | null;
  discountBucket: DiscountBucket;

  // ── Status flags ─────────────────────────────────────────────────────────
  isOutlet: boolean; // feed.outlet metafield
  isExhibitionModel: boolean; // feed.exhibition_model metafield
  isBestseller: boolean; // metafield override OR scoring
  isNew: boolean; // publishedAt within new_product_days
  isDiscontinued: boolean; // feed.discontinued metafield

  // ── Inventory ─────────────────────────────────────────────────────────────
  availability: AvailabilityStatus;
  stockTotal: number | null;
  stockOnline: number | null;
  stockEupen: number | null;
  pickupEupen: boolean;

  // ── Images ────────────────────────────────────────────────────────────────
  primaryImage: ImageAsset | null;
  lifestyleImage: ImageAsset | null;
  additionalImages: ImageAsset[];

  // ── URLs ──────────────────────────────────────────────────────────────────
  productUrl: string;

  // ── Logistics ─────────────────────────────────────────────────────────────
  shippingClass: string | null;
  returnClass: string | null;
  weight: number | null; // kg
  weightUnit: string | null;
  requiresShipping: boolean;

  // ── Recommendations ───────────────────────────────────────────────────────
  relatedProductIds: string[];
  complementaryProductIds: string[];

  // ── Google Custom Labels ──────────────────────────────────────────────────
  customLabels: {
    custom_label_0: string; // lifecycle: outlet|sale|new|evergreen
    custom_label_1: string; // performance: bestseller|high|medium|low|unknown
    custom_label_2: string; // price_band: 0_500|500_1000|...
    custom_label_3: string; // discount: none|1_10|...
    custom_label_4: string; // inventory: online|showroom|...
  };

  // ── Quality ───────────────────────────────────────────────────────────────
  dataQualityScore: number; // 0-100
  exclusionReasons: ExclusionReason[]; // empty = eligible

  // ── Timestamps ────────────────────────────────────────────────────────────
  sourceUpdatedAt: string; // ISO from Shopify
  generatedAt: string; // ISO of this build
}

// ── Input types for builder ──────────────────────────────────────────────────

/** Raw DB product row (from productsTable). */
export interface ProductRow {
  id: string;
  shopifyGid: string;
  shopifyId: string;
  handle: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  status: string;
  publishedAt: Date | null;
  sourceUpdatedAt: Date | null;
}

/** Raw DB variant row (from variantsTable). */
export interface VariantRow {
  id: string;
  productId: string;
  shopifyGid: string;
  shopifyId: string;
  title: string;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  inventoryItemId: string | null;
  weight: string | null;
  weightUnit: string | null;
  requiresShipping: boolean;
  taxable: boolean;
  available: boolean;
  metafieldOutlet: boolean | null;
  metafieldExhibitionModel: boolean | null;
  metafieldExhibitionStore: string | null;
  metafieldBestseller: boolean | null;
  metafieldDiscontinued: boolean | null;
  metafieldShippingClass: string | null;
  metafieldReturnClass: string | null;
  metafieldGoogleCategory: string | null;
  metafieldMetaCategory: string | null;
  metafieldMaterial: string[] | null;
  metafieldStyle: string[] | null;
  metafieldRoom: string[] | null;
  metafieldIndoorOutdoor: string | null;
  metafieldLifestyleImageOverride: string | null;
  metafieldPrimaryImageOverride: string | null;
  sourceUpdatedAt: Date | null;
}

/** Raw DB market variant row (from marketVariantsTable). */
export interface MarketVariantRow {
  variantId: string;
  marketCode: string;
  priceAmount: string | null;
  priceCurrency: string | null;
  compareAtPriceAmount: string | null;
  availability: string;
  productUrl: string | null;
  isEligible: boolean;
}

/** Raw DB product translation row. */
export interface TranslationRow {
  productId: string;
  language: string;
  title: string | null;
  description: string | null;
  handle: string | null;
}

/** Raw DB image row. */
export interface ImageRow {
  id: string;
  productId: string;
  shopifyGid: string | null;
  url: string;
  urlHash: string;
  altText: string | null;
  position: number;
  width: number | null;
  height: number | null;
  imageType: string | null;
  whiteBgScore: string | null;
  solidBgScore: string | null;
  alphaRatio: string | null;
  isClassified: boolean;
}

/** Raw DB inventory level row. */
export interface InventoryRow {
  variantId: string;
  shopifyLocationId: string;
  locationName: string | null;
  available: number;
}

/** Raw DB recommendations row. */
export interface RecommendationRow {
  productId: string;
  marketCode: string;
  relatedProductIds: string[];
  complementaryProductIds: string[];
}
