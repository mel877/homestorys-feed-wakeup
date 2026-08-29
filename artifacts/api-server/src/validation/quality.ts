/**
 * Data quality scorer — spec section 44.
 *
 * Score 0-100, weighted by domain:
 *   identity       20  (brand, title, sku, item_group_id)
 *   pricing        15  (price, currency, no invalid sale price)
 *   inventory      15  (availability set, stock data present)
 *   images         15  (at least one valid image, primary classified)
 *   classification 10  (category mapped, google/meta categories set)
 *   content        10  (title length, description present)
 *   identifiers    10  (gtin or mpn present and valid)
 *   shipping        5  (shipping class set)
 */

import type { CanonicalProduct } from "../canonical/types";
import type { FeedPolicyConfig } from "../config/schemas";
import { isValidSalePrice } from "../promotions/index";

export interface QualityBreakdown {
  score: number; // 0-100
  identity: number;
  pricing: number;
  inventory: number;
  images: number;
  classification: number;
  content: number;
  identifiers: number;
  shipping: number;
  details: string[];
}

const DEFAULT_WEIGHTS: FeedPolicyConfig["quality_weights"] = {
  identity: 20,
  pricing: 15,
  inventory: 15,
  images: 15,
  classification: 10,
  content: 10,
  identifiers: 10,
  shipping: 5,
};

/**
 * Compute a 0-100 data quality score for a canonical product.
 */
export function computeQualityScore(
  product: CanonicalProduct,
  weights: FeedPolicyConfig["quality_weights"] = DEFAULT_WEIGHTS,
): QualityBreakdown {
  const details: string[] = [];

  // ── Identity (20 pts) ────────────────────────────────────────────────────
  let identityRatio = 0;
  const identityChecks = [
    !!product.brand && product.brand.length > 0,
    !!product.title && product.title.length >= 10,
    !!product.sku,
    !!product.itemGroupId,
  ];
  identityRatio = identityChecks.filter(Boolean).length / identityChecks.length;
  if (!product.brand) details.push("missing_brand");
  if (!product.sku) details.push("missing_sku");
  if (product.title.length < 10) details.push("title_too_short");

  // ── Pricing (15 pts) ─────────────────────────────────────────────────────
  let pricingRatio = 0;
  const hasValidSale = !product.isOnSale || (
    product.compareAtPrice !== null
    && product.compareAtPrice.currency === product.price.currency
    && product.compareAtPrice.amount === product.price.amount
    && isValidSalePrice(product.price, product.salePrice)
  );
  const pricingChecks = [
    product.price.amount > 0,
    !!product.price.currency,
    // Valid sale: regular/compare-at prices agree and salePrice is strictly lower.
    hasValidSale,
  ];
  pricingRatio = pricingChecks.filter(Boolean).length / pricingChecks.length;
  if (product.price.amount <= 0) details.push("missing_price");
  if (product.isOnSale && !product.compareAtPrice) details.push("sale_price_missing_compare_at");

  // ── Inventory (15 pts) ───────────────────────────────────────────────────
  let inventoryRatio = 0;
  const inventoryChecks = [
    !!product.availability,
    product.stockTotal !== null,
    product.availability !== "discontinued" || product.isDiscontinued,
  ];
  inventoryRatio = inventoryChecks.filter(Boolean).length / inventoryChecks.length;
  if (product.stockTotal === null) details.push("missing_stock_data");

  // ── Images (15 pts) ──────────────────────────────────────────────────────
  let imagesRatio = 0;
  const imageChecks = [
    product.primaryImage !== null,
    product.primaryImage?.imageType !== "invalid",
    product.primaryImage?.imageType !== "unknown",
    product.primaryImage !== null && product.primaryImage.width !== null && (product.primaryImage.width ?? 0) >= 400,
  ];
  imagesRatio = imageChecks.filter(Boolean).length / imageChecks.length;
  if (!product.primaryImage) details.push("missing_primary_image");
  if (product.primaryImage?.imageType === "invalid") details.push("invalid_primary_image");
  if (!product.lifestyleImage) details.push("missing_lifestyle_image");

  // ── Classification (10 pts) ──────────────────────────────────────────────
  let classificationRatio = 0;
  const classificationChecks = [
    !!product.googleProductCategory,
    !!product.metaProductCategory,
    !!product.productType,
  ];
  classificationRatio = classificationChecks.filter(Boolean).length / classificationChecks.length;
  if (!product.googleProductCategory) details.push("missing_google_category");
  if (!product.metaProductCategory) details.push("missing_meta_category");

  // ── Content (10 pts) ─────────────────────────────────────────────────────
  let contentRatio = 0;
  const contentChecks = [
    product.title.length >= 25,
    product.description.length >= 50,
    product.description.length >= 100,
  ];
  contentRatio = contentChecks.filter(Boolean).length / contentChecks.length;
  if (product.description.length < 50) details.push("description_too_short");

  // ── Identifiers (10 pts) ─────────────────────────────────────────────────
  let identifiersRatio = 0;
  const identifierChecks = [
    !!product.gtin,
    !!product.mpn,
    product.identifierExists,
  ];
  identifiersRatio = identifierChecks.filter(Boolean).length / identifierChecks.length;
  if (!product.gtin) details.push("missing_gtin");
  if (!product.mpn) details.push("missing_mpn");

  // ── Shipping (5 pts) ─────────────────────────────────────────────────────
  let shippingRatio = 0;
  const shippingChecks = [
    !!product.shippingClass,
    product.requiresShipping ? product.weight !== null : true,
  ];
  shippingRatio = shippingChecks.filter(Boolean).length / shippingChecks.length;
  if (!product.shippingClass) details.push("missing_shipping_class");

  // ── Weighted total ───────────────────────────────────────────────────────
  const identity = Math.round(identityRatio * weights.identity);
  const pricing = Math.round(pricingRatio * weights.pricing);
  const inventory = Math.round(inventoryRatio * weights.inventory);
  const images = Math.round(imagesRatio * weights.images);
  const classification = Math.round(classificationRatio * weights.classification);
  const content = Math.round(contentRatio * weights.content);
  const identifiers = Math.round(identifiersRatio * weights.identifiers);
  const shipping = Math.round(shippingRatio * weights.shipping);

  const score = Math.min(
    100,
    identity + pricing + inventory + images + classification + content + identifiers + shipping,
  );

  return {
    score,
    identity,
    pricing,
    inventory,
    images,
    classification,
    content,
    identifiers,
    shipping,
    details,
  };
}

/**
 * Determine exclusion reasons for a canonical product on a specific channel.
 */
export function computeExclusionReasons(
  product: CanonicalProduct,
  channel: "google" | "meta",
): string[] {
  const reasons: string[] = [];

  if (product.isDiscontinued) reasons.push("DISCONTINUED");
  if (!product.primaryImage) reasons.push("NO_VALID_IMAGE");
  if (product.primaryImage?.imageType === "invalid") reasons.push("NO_VALID_IMAGE");
  if (product.price.amount <= 0) reasons.push("MISSING_PRICE");
  if (!product.price.currency) reasons.push("INVALID_PRICE");

  // Channel-specific checks
  if (channel === "google") {
    if (!product.title || product.title.length < 5) reasons.push("MISSING_REQUIRED_TRANSLATION");
  }

  if (channel === "meta") {
    if (!product.description || product.description.length < 10) {
      reasons.push("MISSING_REQUIRED_TRANSLATION");
    }
  }

  return [...new Set(reasons)]; // dedupe
}
