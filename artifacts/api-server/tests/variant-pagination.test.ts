/**
 * A targeted product sync may delete DB variants absent from Shopify's response,
 * so it must load every Shopify variant page before making that comparison.
 */

import { describe, expect, it, vi } from "vitest";
import { fetchAllProductVariants } from "../src/shopify/sync-products";
import type { ShopifyClient } from "../src/shopify/client";

function variantNode(index: number) {
  return {
    id: `gid://shopify/ProductVariant/${index}`,
    title: `Variant ${index}`,
    sku: `SKU-${index}`,
    barcode: null,
    position: index,
    price: "10.00",
    compareAtPrice: null,
    taxable: true,
    availableForSale: true,
    inventoryItem: null,
    metafields: { edges: [] },
  };
}

function variantPage(start: number, count: number, hasNextPage: boolean, endCursor: string | null) {
  return {
    pageInfo: { hasNextPage, endCursor },
    edges: Array.from({ length: count }, (_, offset) => ({ node: variantNode(start + offset) })),
  };
}

describe("fetchAllProductVariants", () => {
  it("loads every page before a targeted sync treats the product as authoritative", async () => {
    const firstPage = variantPage(1, 100, true, "page-2");
    const secondPage = variantPage(101, 100, true, "page-3");
    const thirdPage = variantPage(201, 5, false, null);
    const client = {
      request: vi.fn()
        .mockResolvedValueOnce({ product: { variants: secondPage } })
        .mockResolvedValueOnce({ product: { variants: thirdPage } }),
    };

    const variants = await fetchAllProductVariants(
      client as unknown as ShopifyClient,
      "gid://shopify/Product/123",
      firstPage,
    );

    expect(variants).toHaveLength(205);
    expect(variants[0]!.node.id).toBe("gid://shopify/ProductVariant/1");
    expect(variants[204]!.node.id).toBe("gid://shopify/ProductVariant/205");
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("GetProductVariants"),
      { id: "gid://shopify/Product/123", cursor: "page-2" },
      { expectedCost: 15 },
    );
  });
});