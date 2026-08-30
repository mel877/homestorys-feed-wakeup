/**
 * Canonical Product Builder — assembles a CanonicalProduct from raw DB data.
 *
 * This is a pure function (all DB loading is done by the caller).
 * One CanonicalProduct is built per (variant × market × language).
 *
 * All business rules applied here:
 * - Title construction (spec section 28)
 * - Description sanitisation (spec section 29)
 * - GTIN/MPN validation (spec section 79)
 * - Promotion detection (spec section 15)
 * - Inventory derivation (spec section 20)
 * - Image selection (spec section 19)
 * - Category mapping (spec section 27)
 * - Custom labels (spec section 31)
 * - Bestseller classification (spec section 18)
 * - Data quality score (spec section 44)
 */

import type {
  CanonicalProduct,
  ProductRow,
  VariantRow,
  MarketVariantRow,
  TranslationRow,
  ImageRow,
  InventoryRow,
  RecommendationRow,
  ImageAsset,
  ExclusionReason,
} from "./types";
import type { AppConfig } from "../config/schemas";

import {
  buildTitle,
  sanitizeDescription,
  validateGtin,
  validateMpn,
  normaliseBrand,
  extractColors,
  isNewProduct,
  normaliseWeight,
} from "../normalization/index";
import { computePromotion, buildMoney } from "../promotions/index";
import { computeInventory } from "../inventory/index";
import { mapCategory } from "../categories/mapper";
import { computeCustomLabels } from "./labels";
import { determineBestsellerClass } from "../enrichment/bestseller";
import {
  buildShopifyProductUrl,
  resolveMarket,
  resolveContent,
  resolvePricing,
} from "../markets/resolver";
import { selectGoogleImages, selectMetaImages } from "../images/classifier";
import { computeQualityScore, computeExclusionReasons } from "../validation/quality";

export interface BuildCanonicalInput {
  product: ProductRow;
  variant: VariantRow;
  marketVariants: MarketVariantRow[];
  translations: TranslationRow[];
  images: ImageRow[];
  inventoryLevels: InventoryRow[];
  recommendations: RecommendationRow | null;
  /**
   * Normalised bestseller score 0-1, computed from order data.
   * Null if order data not available.
   */
  normalizedBestsellerScore: number | null;
  config: AppConfig;
}

export type CanonicalChannel = "google" | "meta";

/** Coerce a Date | string | null to ISO string, handles JSON-parsed string dates */
function toISOStringSafe(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  // Already an ISO string from JSON fixture / JSON.parse
  return value;
}

/**
 * Build a CanonicalProduct for a specific market using the Google channel
 * image priority. For Meta channel, use buildCanonicalForMeta().
 */
export function buildCanonical(
  input: BuildCanonicalInput,
  marketCode: string,
  channel: CanonicalChannel = "google",
): CanonicalProduct | null {
  const { product, variant, translations, images, inventoryLevels, config } = input;

  // ── Publication guard ─────────────────────────────────────────────────────
  // Draft/archived products must never reach any channel feed.
  // Return null (not just exclusion reasons) so exporters never emit them.
  if (product.status !== "active") return null;

  // ── Resolve market ────────────────────────────────────────────────────────
  const market = resolveMarket(marketCode, config.markets);
  if (!market) return null; // unconfigured market — skip

  // ── Resolve pricing ────────────────────────────────────────────────────────
  // Some storefront languages share one Shopify commercial market. In that
  // case the price still comes from the same country, never another country.
  const pricingMarketCode = market.pricing_market ?? marketCode;
  const pricing = resolvePricing(pricingMarketCode, input.marketVariants, market.currency);
  if (!pricing) return null; // no market variant row → product not available in this market

  // Swiss canonicals must only use the CHF contextual price persisted by the
  // Shopify pricing sync. Never convert or substitute a non-CHF price.
  if (market.currency === "CHF" && pricing.priceCurrency !== "CHF") return null;

  if (!pricing.isEligible) return null; // explicitly ineligible

  // ── Resolve content ────────────────────────────────────────────────────────
  const content = resolveContent(market.language, product.handle, translations);

  // ── Policy exclusions — handle / product type (Channable rule set v1.0) ───
  // Rule 1.2 — handle contains "calendrier" (advent calendars, seasonal items)
  if (product.handle.includes("calendrier")) return null;

  // Vendor exclusions — brands excluded from all feeds (Channable Brand exclusion 1-3)
  const vendorLower = (product.vendor ?? "").toLowerCase();
  if (
    vendorLower &&
    (config.exclusions?.excluded_vendors ?? []).some((v) => v.toLowerCase() === vendorLower)
  ) return null;

  // Product type exclusions — categories excluded from all feeds (Channable Product type exclusion 1-3)
  const productTypeLower = (product.productType ?? "").toLowerCase();
  if (
    productTypeLower &&
    (config.exclusions?.excluded_product_types ?? []).some((t) => productTypeLower.includes(t.toLowerCase()))
  ) return null;

  // Rules 2.5, 2.6, 2.8, 3.15 — title-based content exclusions
  const titleLower = (content.title ?? "").toLowerCase();
  if (
    titleLower.includes("calendrier") ||  // rules 1.2, 2.5 — advent calendars
    titleLower.includes("expo") ||        // rule 2.6 — showroom / expo products
    titleLower.includes("livre") ||       // rule 2.8 — books
    titleLower.includes("langify") ||     // rule 3.15 — Langify translation artefacts
    (market.language === "de" && titleLower.includes("hardwax"))
  ) return null;

  // ── Brand normalisation ───────────────────────────────────────────────────
  const brand = normaliseBrand(product.vendor) || "Homestorys";

  // ── Title ─────────────────────────────────────────────────────────────────
  const baseProductTitle = content.title ?? product.handle.replace(/-/g, " ");
  const title = buildTitle({
    brand,
    productTitle: baseProductTitle,
    variantTitle: variant.title,
    productType: product.productType,
  });

  // ── Description ───────────────────────────────────────────────────────────
  const description = sanitizeDescription(content.description);

  // ── Identifiers ───────────────────────────────────────────────────────────
  const gtin = validateGtin(variant.gtin);
  const mpn = validateMpn(variant.mpn);
  const identifierExists = !!(gtin || mpn);

  // ── Promotion ─────────────────────────────────────────────────────────────
  const promo = computePromotion(
    pricing.priceAmount,
    pricing.compareAtPriceAmount,
    pricing.priceCurrency,
  );

  // Price validation fail-safe (spec section 88)
  if (promo.priceInvalid) {
    // Return null = exclude this market from feed
    return null;
  }

  // Rule 2.7 — exclude products priced above 10,000 € (Channable rule set v1.0)
  if (parseFloat(pricing.priceAmount ?? "0") > 10_000) return null;

  const currentPrice = buildMoney(pricing.priceAmount, pricing.priceCurrency)!;
  const compareAtPrice = buildMoney(pricing.compareAtPriceAmount, pricing.priceCurrency);
  const price = promo.isOnSale && compareAtPrice ? compareAtPrice : currentPrice;

  // ── Inventory ─────────────────────────────────────────────────────────────
  const eupenLocationId = config.stores.stores["eupen"]?.shopify_location_id ?? null;

  // made_to_order and backorder return classes imply the variant can be sold when OOS
  const returnClassRaw = variant.metafieldReturnClass ?? config.returns.default_class;
  const sellWhenOutOfStock =
    returnClassRaw === "made_to_order" || returnClassRaw === "backorder";

  const inv = computeInventory(
    inventoryLevels,
    eupenLocationId,
    variant.requiresShipping,
    sellWhenOutOfStock,
    variant.metafieldDiscontinued ?? false,
  );

  // ── Images ────────────────────────────────────────────────────────────────
  const classifiedImages = images.map((img) => ({
    url: img.url,
    urlHash: img.urlHash,
    altText: img.altText,
    width: img.width,
    height: img.height,
    imageType: (img.imageType ?? "unknown") as ImageAsset["imageType"],
    position: img.position,
  }));

  const selected =
    channel === "meta"
      ? selectMetaImages(
          classifiedImages,
          variant.metafieldPrimaryImageOverride,
          variant.metafieldLifestyleImageOverride,
        )
      : selectGoogleImages(
          classifiedImages,
          variant.metafieldPrimaryImageOverride,
          variant.metafieldLifestyleImageOverride,
        );

  const toAsset = (img: (typeof classifiedImages)[0] | null): ImageAsset | null => {
    if (!img) return null;
    return {
      url: img.url,
      urlHash: img.urlHash,
      altText: img.altText,
      width: img.width,
      height: img.height,
      imageType: img.imageType,
      position: img.position,
    };
  };

  const primaryImage = toAsset(selected.primary);
  const lifestyleImage = toAsset(selected.lifestyle);
  const additionalImages = selected.additional.map((i) => toAsset(i)!);

  // ── Category ──────────────────────────────────────────────────────────────
  const categoryResult = mapCategory(
    product.productType,
    [],
    config.categories,
    variant.metafieldGoogleCategory,
    variant.metafieldMetaCategory,
  );

  // ── Attributes ────────────────────────────────────────────────────────────
  const colors = extractColors({
    variantTitle: variant.title,
    productTitle: baseProductTitle,
    tags: product.tags,
  });

  // ── Status flags ──────────────────────────────────────────────────────────
  const isOutlet = variant.metafieldOutlet ?? false;
  const isExhibitionModel = variant.metafieldExhibitionModel ?? false;
  const isDiscontinued = variant.metafieldDiscontinued ?? false;
  // Coerce publishedAt to Date — may be a string when loaded from JSON fixtures
  const publishedAtDate =
    product.publishedAt instanceof Date
      ? product.publishedAt
      : product.publishedAt
        ? new Date(product.publishedAt as unknown as string)
        : null;
  const isNew = isNewProduct(publishedAtDate, config.labels.new_product_days);

  // ── Bestseller ────────────────────────────────────────────────────────────
  const bestseller = determineBestsellerClass(
    variant.metafieldBestseller,
    input.normalizedBestsellerScore,
  );

  // ── URL ───────────────────────────────────────────────────────────────────
  // Primary source: productUrl set by sync-markets from Shopify webPresence.rootUrls.
  // Fallback: construct from per-market base_url (config/markets.yaml) + localized handle.
  const localizedHandle = content.handle ?? product.handle;
  const marketBaseUrl = market.base_url ?? "https://shop.homestorys.com/";
  // A language alias must use its own storefront URL, not the source
  // commercial market's URL (for example Swiss French reuses CH pricing).
  const productUrl = market.pricing_market
    ? buildShopifyProductUrl(marketBaseUrl, localizedHandle, variant.shopifyGid)
    : pricing.productUrl
      ?? buildShopifyProductUrl(marketBaseUrl, localizedHandle, variant.shopifyGid);

  // ── Weight ────────────────────────────────────────────────────────────────
  const weightNorm = normaliseWeight(variant.weight, variant.weightUnit);

  // ── Product URL ───────────────────────────────────────────────────────────
  const shippingClass =
    variant.metafieldShippingClass ?? config.shipping.default_class;
  const returnClass =
    variant.metafieldReturnClass ?? config.returns.default_class;

  // ── Recommendations ───────────────────────────────────────────────────────
  const relatedProductIds = input.recommendations?.relatedProductIds ?? [];
  const complementaryProductIds = input.recommendations?.complementaryProductIds ?? [];

  // ── Custom labels ─────────────────────────────────────────────────────────
  const customLabels = computeCustomLabels({
    isOutlet,
    isOnSale: promo.isOnSale,
    isNew,
    isBestseller: bestseller.isBestseller,
    bestsellerClass: bestseller.class,
    priceAmount: price.amount,
    discountBucket: promo.discountBucket,
    inventoryLabel: inv.inventoryLabel,
    config: config.labels,
  });

  // ── Assemble canonical ────────────────────────────────────────────────────
  const canonical: CanonicalProduct = {
    id: variant.id,
    productId: product.id,
    variantId: variant.id,
    itemGroupId: product.shopifyGid,

    sku: variant.sku,
    gtin,
    mpn,
    identifierExists,

    brand,
    vendor: product.vendor,

    language: market.language,
    market: marketCode,

    title,
    description,
    productType: product.productType,
    collections: [],

    googleProductCategory: categoryResult.googleCategoryId,
    metaProductCategory: categoryResult.metaCategory,

    material: variant.metafieldMaterial ?? [],
    color: colors,
    style: variant.metafieldStyle ?? [],
    room: variant.metafieldRoom ?? [],
    indoorOutdoor: (variant.metafieldIndoorOutdoor as CanonicalProduct["indoorOutdoor"]) ??
      (categoryResult.indoorOutdoor ?? null),

    price,
    compareAtPrice,
    salePrice: promo.isOnSale ? promo.salePrice : null,

    isOnSale: promo.isOnSale,
    discountPercentage: promo.discountPercentage,
    discountBucket: promo.discountBucket,

    isOutlet,
    isExhibitionModel,
    isBestseller: bestseller.isBestseller,
    isNew,
    isDiscontinued,

    availability: inv.availability,
    stockTotal: inv.stockTotal,
    stockOnline: inv.stockOnline,
    stockEupen: inv.stockEupen,
    pickupEupen: inv.pickupEupen,

    primaryImage,
    lifestyleImage,
    additionalImages,

    productUrl,

    shippingClass,
    returnClass,
    weight: weightNorm?.value ?? null,
    weightUnit: weightNorm?.unit ?? null,
    requiresShipping: variant.requiresShipping,

    relatedProductIds,
    complementaryProductIds,

    customLabels,

    dataQualityScore: 0, // computed below
    exclusionReasons: [] as ExclusionReason[],

    sourceUpdatedAt: toISOStringSafe(variant.sourceUpdatedAt ?? product.sourceUpdatedAt ?? new Date()),
    generatedAt: new Date().toISOString(),
  };

  // ── Quality score ─────────────────────────────────────────────────────────
  const quality = computeQualityScore(canonical, config.feedPolicy.quality_weights);
  canonical.dataQualityScore = quality.score;

  // ── Exclusion reasons ─────────────────────────────────────────────────────
  canonical.exclusionReasons = computeExclusionReasons(canonical, channel) as ExclusionReason[];

  return canonical;
}
