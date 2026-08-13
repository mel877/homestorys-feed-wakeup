/**
 * fetchAllProductImages pagination test.
 *
 * Verifies that fetchAllProductImages() fetches images from all pages until
 * hasNextPage = false, including catalogs with more than 30 images (the
 * first:30 cap in the original SINGLE_PRODUCT_QUERY).
 *
 * Uses a mock ShopifyClient that returns cursor-paginated responses.
 */

import { describe, it, expect, vi } from "vitest";
import { fetchAllProductImages } from "../src/shopify/sync-products";
import type { ShopifyClient } from "../src/shopify/client";

// ── Mock ShopifyClient ────────────────────────────────────────────────────────

function makeImageNode(i: number) {
  return {
    id: `gid://shopify/MediaImage/${i}`,
    url: `https://cdn.shopify.com/image-${i}.jpg`,
    altText: null,
    width: 1200,
    height: 1200,
  };
}

/** Build a mock ShopifyClient.request that returns paginated image responses. */
function makePaginatedClient(totalImages: number, pageSize = 50): Pick<ShopifyClient, "request"> {
  const allImages = Array.from({ length: totalImages }, (_, i) => makeImageNode(i + 1));

  return {
    request: vi.fn().mockImplementation(
      async (_query: string, vars: Record<string, unknown>) => {
        const cursor = vars.cursor as string | null ?? null;
        const startIdx = cursor ? parseInt(cursor, 10) : 0;
        const pageImages = allImages.slice(startIdx, startIdx + pageSize);
        const nextIdx = startIdx + pageSize;
        const hasNextPage = nextIdx < totalImages;

        return {
          product: {
            images: {
              pageInfo: {
                hasNextPage,
                endCursor: hasNextPage ? String(nextIdx) : null,
              },
              edges: pageImages.map((img) => ({ node: img })),
            },
          },
        };
      },
    ),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchAllProductImages pagination", () => {
  it("fetches exactly 30 images in one page (no truncation)", async () => {
    const client = makePaginatedClient(30);
    const images = await fetchAllProductImages(
      client as unknown as ShopifyClient,
      "gid://shopify/Product/1",
    );

    expect(images).toHaveLength(30);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("fetches 51 images across two pages (exceeds single-page cap)", async () => {
    const client = makePaginatedClient(51);
    const images = await fetchAllProductImages(
      client as unknown as ShopifyClient,
      "gid://shopify/Product/2",
    );

    expect(images).toHaveLength(51);
    // 51 images: page 1 (50) + page 2 (1) = 2 requests
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("fetches 200 images across 4 pages", async () => {
    const client = makePaginatedClient(200);
    const images = await fetchAllProductImages(
      client as unknown as ShopifyClient,
      "gid://shopify/Product/3",
    );

    expect(images).toHaveLength(200);
    expect(client.request).toHaveBeenCalledTimes(4);
  });

  it("fetches 0 images when product has no images", async () => {
    const client = makePaginatedClient(0);
    const images = await fetchAllProductImages(
      client as unknown as ShopifyClient,
      "gid://shopify/Product/4",
    );

    expect(images).toHaveLength(0);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("attaches correct __parentId to all fetched images", async () => {
    const productGid = "gid://shopify/Product/999";
    const client = makePaginatedClient(5);
    const images = await fetchAllProductImages(
      client as unknown as ShopifyClient,
      productGid,
    );

    for (const img of images) {
      expect(img.__parentId).toBe(productGid);
    }
  });

  it("returns images in correct order across page boundaries", async () => {
    const client = makePaginatedClient(75);
    const images = await fetchAllProductImages(
      client as unknown as ShopifyClient,
      "gid://shopify/Product/5",
    );

    expect(images).toHaveLength(75);
    // Verify sequential IDs (image-1 through image-75) in order
    for (let i = 0; i < images.length; i++) {
      expect(images[i]!.id).toBe(`gid://shopify/MediaImage/${i + 1}`);
    }
  });
});
