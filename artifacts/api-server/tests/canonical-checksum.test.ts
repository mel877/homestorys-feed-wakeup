/**
 * Regression tests for the canonical feed-item checksum.
 *
 * The checksum must:
 * - Change when any business-significant field changes (price, availability,
 *   title, images, custom labels, etc.)
 * - Be stable across runs — identical canonicals get the same checksum
 * - Not change when only generatedAt changes (volatile timestamp)
 */

import { describe, it, expect } from "vitest";
import { computeChecksum } from "../src/shopify/checksums";
import type { CanonicalProduct } from "../src/canonical/types";

// ── The same canonicalChecksum logic used in canonical-reader.ts ──────────────
// (Inline here so this test doesn't import the DB-importing module)

function canonicalChecksum(c: CanonicalProduct): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { generatedAt: _omit, ...stable } = c;
  return computeChecksum(stable);
}

// ── Fixture ───────────────────────────────────────────────────────────────────

function baseCanonical(): CanonicalProduct {
  return {
    id: "var-uuid-1",
    productId: "prod-uuid-1",
    variantId: "var-uuid-1",
    itemGroupId: "gid://shopify/Product/1",
    sku: "SKU-001",
    gtin: "5901234123457",
    mpn: null,
    identifierExists: true,
    brand: "Homestorys",
    vendor: "Homestorys",
    language: "fr",
    market: "FR",
    title: "Canapé 3 places",
    description: "Un canapé confortable.",
    productType: "Canape",
    collections: ["Salon"],
    googleProductCategory: "436",
    metaProductCategory: "Furniture",
    material: ["Tissu"],
    color: ["Gris"],
    style: [],
    room: ["Salon"],
    indoorOutdoor: "indoor",
    price: { amount: 599, currency: "EUR", formatted: "€599.00" },
    compareAtPrice: null,
    salePrice: null,
    isOnSale: false,
    discountPercentage: null,
    discountBucket: "none",
    isOutlet: false,
    isExhibitionModel: false,
    isBestseller: false,
    isNew: false,
    isDiscontinued: false,
    availability: "in_stock",
    stockTotal: 3,
    stockOnline: 3,
    stockEupen: 0,
    pickupEupen: false,
    primaryImage: {
      url: "https://cdn.example.com/img.jpg",
      urlHash: "abc",
      altText: null,
      width: 1200,
      height: 900,
      imageType: "packshot_white",
      position: 1,
    },
    lifestyleImage: null,
    additionalImages: [],
    productUrl: "https://example.com/fr/products/canape",
    shippingClass: "bulky",
    returnClass: "standard",
    weight: 45,
    weightUnit: "kg",
    requiresShipping: true,
    relatedProductIds: [],
    complementaryProductIds: [],
    customLabels: {
      custom_label_0: "evergreen",
      custom_label_1: "medium",
      custom_label_2: "500_1000",
      custom_label_3: "none",
      custom_label_4: "online",
    },
    dataQualityScore: 85,
    exclusionReasons: [],
    sourceUpdatedAt: "2024-01-15T10:00:00.000Z",
    generatedAt: "2024-01-16T08:00:00.000Z",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("canonical feed-item checksum", () => {
  it("is stable — same canonical produces same checksum across two calls", () => {
    const canonical = baseCanonical();
    const c1 = canonicalChecksum(canonical);
    const c2 = canonicalChecksum(canonical);
    expect(c1).toBe(c2);
  });

  it("does NOT change when only generatedAt changes", () => {
    const c1 = canonicalChecksum({ ...baseCanonical(), generatedAt: "2024-01-16T08:00:00.000Z" });
    const c2 = canonicalChecksum({ ...baseCanonical(), generatedAt: "2024-06-30T12:34:56.789Z" });
    expect(c1).toBe(c2);
  });

  it("changes when price changes", () => {
    const c1 = canonicalChecksum(baseCanonical());
    const c2 = canonicalChecksum({
      ...baseCanonical(),
      price: { amount: 649, currency: "EUR", formatted: "€649.00" },
    });
    expect(c1).not.toBe(c2);
  });

  it("changes when availability changes", () => {
    const c1 = canonicalChecksum(baseCanonical());
    const c2 = canonicalChecksum({ ...baseCanonical(), availability: "out_of_stock" });
    expect(c1).not.toBe(c2);
  });

  it("changes when title changes", () => {
    const c1 = canonicalChecksum(baseCanonical());
    const c2 = canonicalChecksum({ ...baseCanonical(), title: "Canapé 2 places" });
    expect(c1).not.toBe(c2);
  });

  it("changes when primary image URL changes", () => {
    const c1 = canonicalChecksum(baseCanonical());
    const c2 = canonicalChecksum({
      ...baseCanonical(),
      primaryImage: { ...baseCanonical().primaryImage!, url: "https://cdn.example.com/new-img.jpg" },
    });
    expect(c1).not.toBe(c2);
  });

  it("changes when sale price is added (isOnSale goes true)", () => {
    const c1 = canonicalChecksum(baseCanonical());
    const c2 = canonicalChecksum({
      ...baseCanonical(),
      isOnSale: true,
      salePrice: { amount: 499, currency: "EUR", formatted: "€499.00" },
      discountBucket: "11_20",
      discountPercentage: 17,
    });
    expect(c1).not.toBe(c2);
  });

  it("changes when custom labels change", () => {
    const c1 = canonicalChecksum(baseCanonical());
    const c2 = canonicalChecksum({
      ...baseCanonical(),
      customLabels: { ...baseCanonical().customLabels, custom_label_0: "sale" },
    });
    expect(c1).not.toBe(c2);
  });

  it("changes when stock numbers change", () => {
    const c1 = canonicalChecksum(baseCanonical());
    const c2 = canonicalChecksum({ ...baseCanonical(), stockTotal: 0, stockOnline: 0 });
    expect(c1).not.toBe(c2);
  });

  it("changes when isBestseller flips", () => {
    const c1 = canonicalChecksum(baseCanonical());
    const c2 = canonicalChecksum({ ...baseCanonical(), isBestseller: true });
    expect(c1).not.toBe(c2);
  });

  it("changes when market changes (same variant, different market)", () => {
    const c1 = canonicalChecksum(baseCanonical());
    const c2 = canonicalChecksum({ ...baseCanonical(), market: "BE_FR" });
    expect(c1).not.toBe(c2);
  });

  it("produces different checksums for two different variants", () => {
    const c1 = canonicalChecksum(baseCanonical());
    const c2 = canonicalChecksum({ ...baseCanonical(), variantId: "var-uuid-2", id: "var-uuid-2" });
    expect(c1).not.toBe(c2);
  });
});
