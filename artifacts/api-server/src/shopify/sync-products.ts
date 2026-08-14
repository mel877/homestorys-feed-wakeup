/**
 * Full product + variant sync via Shopify Bulk Operations.
 *
 * One bulk operation fetches: products → variants → feed.* metafields → images.
 * Checksums detect unchanged records so only truly changed rows are written.
 */

import { db, productsTable, variantsTable, imagesTable, productTranslationsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";
import type { ShopifyClient } from "./client";
import { runBulkQuery } from "./bulk-ops";
import { computeChecksum, hashUrl, hasChanged } from "./checksums";
import type { SyncRunTracker } from "./sync-run-tracker";
import type {
  BulkNode,
  BulkProductNode,
  BulkVariantNode,
  BulkMetafieldNode,
  BulkImageNode,
  ParsedFeedMetafields,
} from "./types";

const logger = rootLogger.child({ module: "sync-products" });

// ── GraphQL bulk query ────────────────────────────────────────────────────────

// Bulk operations use standard GraphQL connection syntax (edges/node).
// Shopify flattens the JSONL output and sets __parentId for child records.
// No pagination args — bulk ops automatically return all records.
const BULK_PRODUCTS_QUERY = `
{
  products {
    edges {
      node {
        id
        title
        handle
        descriptionHtml
        vendor
        productType
        tags
        status
        publishedAt
        updatedAt
        variants {
          edges {
            node {
              id
              title
              sku
              barcode
              position
              price
              compareAtPrice
              taxable
              availableForSale
              inventoryItem {
                id
                requiresShipping
                measurement {
                  weight {
                    value
                    unit
                  }
                }
              }
              metafields(namespace: "feed") {
                edges {
                  node {
                    id
                    namespace
                    key
                    value
                    type
                  }
                }
              }
            }
          }
        }
        images {
          edges {
            node {
              id
              url
              altText
              width
              height
            }
          }
        }
      }
    }
  }
}
`;

// Single-product targeted fetch (for webhook delta updates)
export const SINGLE_PRODUCT_QUERY = `
  query GetProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
      vendor
      productType
      tags
      status
      publishedAt
      updatedAt
      variants(first: 100) {
        edges {
          node {
            id
            title
            sku
            barcode
            position
            price
            compareAtPrice
            taxable
            availableForSale
            inventoryItem {
              id
              requiresShipping
              measurement { weight { value unit } }
            }
            metafields(namespace: "feed", first: 30) {
              edges {
                node { id namespace key value type }
              }
            }
          }
        }
      }
    }
  }
`;

// Paginated product-images query — used by syncSingleProduct to fetch ALL images
// without the first:30 cap that truncates products with many images.
const PRODUCT_IMAGES_QUERY = `
  query GetProductImages($id: ID!, $cursor: String) {
    product(id: $id) {
      images(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node { id url altText width height }
        }
      }
    }
  }
`;

interface ProductImagesResponse {
  product: {
    images: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{
        node: {
          id: string;
          url: string;
          altText: string | null;
          width: number | null;
          height: number | null;
        };
      }>;
    };
  } | null;
}

type ProductImagesPage = NonNullable<ProductImagesResponse["product"]>["images"];

/** Fetch ALL product images via cursor pagination (avoids first:N cap). */
export async function fetchAllProductImages(
  client: ShopifyClient,
  productGid: string,
): Promise<BulkImageNode[]> {
  const images: BulkImageNode[] = [];
  let cursor: string | null = null;

  for (;;) {
    const response: ProductImagesResponse = await client.request<ProductImagesResponse>(
      PRODUCT_IMAGES_QUERY,
      { id: productGid, cursor },
      { expectedCost: 5 },
    );

    const page: ProductImagesPage | null = response.product?.images ?? null;
    if (!page) break;

    for (const { node: img } of page.edges) {
      images.push({
        id: img.id,
        __parentId: productGid,
        url: img.url,
        altText: img.altText,
        width: img.width,
        height: img.height,
      });
    }

    if (page.pageInfo.hasNextPage) {
      cursor = page.pageInfo.endCursor;
    } else {
      break;
    }
  }

  return images;
}

// ── Node type guards ──────────────────────────────────────────────────────────

function isProductNode(n: BulkNode): boolean {
  return !n.__parentId && n.id.includes("/Product/");
}
function isVariantNode(n: BulkNode): boolean {
  return !!n.__parentId && n.id.includes("/ProductVariant/");
}
function isMetafieldNode(n: BulkNode): boolean {
  return !!n.__parentId && n.id.includes("/Metafield/");
}
function isImageNode(n: BulkNode): boolean {
  return (
    !!n.__parentId &&
    // Shopify bulk op emits product images as gid://shopify/ProductImage/...
    // (not /Image/ or /MediaImage/ which were older patterns).
    (n.id.includes("/ProductImage/") ||
      n.id.includes("/MediaImage/") ||
      n.id.includes("/Image/"))
  );
}

// ── Metafield parsing ─────────────────────────────────────────────────────────

function parseBool(val: string | undefined): boolean | null {
  if (val === undefined || val === null || val === "") return null;
  return val.toLowerCase() === "true";
}

function parseList(val: string | undefined): string[] | null {
  if (!val) return null;
  try {
    const parsed = JSON.parse(val) as unknown;
    if (Array.isArray(parsed)) return (parsed as unknown[]).map(String);
  } catch {
    // ignore
  }
  return null;
}

function parseMetafields(nodes: BulkMetafieldNode[]): ParsedFeedMetafields {
  const raw: Record<string, string> = {};
  for (const m of nodes) {
    if (m.namespace === "feed") raw[m.key] = m.value;
  }
  return {
    outlet: parseBool(raw["outlet"]),
    exhibitionModel: parseBool(raw["exhibition_model"]),
    exhibitionStore: raw["exhibition_store"] ?? null,
    bestseller: parseBool(raw["bestseller"]),
    discontinued: parseBool(raw["discontinued"]),
    shippingClass: raw["shipping_class"] ?? null,
    returnClass: raw["return_class"] ?? null,
    googleCategory: raw["google_category"] ?? null,
    metaCategory: raw["meta_category"] ?? null,
    material: parseList(raw["material"]),
    style: parseList(raw["style"]),
    room: parseList(raw["room"]),
    indoorOutdoor: raw["indoor_outdoor"] ?? null,
    lifestyleImageOverride: raw["lifestyle_image_override"] ?? null,
    primaryImageOverride: raw["primary_image_override"] ?? null,
    mpn: raw["mpn"] ?? null,
    raw,
  };
}

// ── Row builders ──────────────────────────────────────────────────────────────

type ProductInsert = typeof productsTable.$inferInsert;
type VariantInsert = typeof variantsTable.$inferInsert;
type ImageInsert = typeof imagesTable.$inferInsert;
type TranslationInsert = typeof productTranslationsTable.$inferInsert;

function buildProductRow(node: BulkProductNode): Omit<ProductInsert, "id" | "createdAt" | "updatedAt" | "checksum"> {
  const shopifyId = node.id.split("/").pop() ?? node.id;
  return {
    shopifyGid: node.id,
    shopifyId,
    handle: node.handle,
    vendor: node.vendor ?? null,
    productType: node.productType ?? null,
    tags: (node.tags as string[]) ?? [],
    status: (node.status as string).toLowerCase(),
    publishedAt: node.publishedAt ? new Date(node.publishedAt) : null,
    sourceUpdatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}

function buildVariantRow(
  node: BulkVariantNode,
  metafields: BulkMetafieldNode[],
  productDbId: string,
): Omit<VariantInsert, "id" | "createdAt" | "updatedAt" | "checksum"> {
  const shopifyId = node.id.split("/").pop() ?? node.id;
  const meta = parseMetafields(metafields);
  const inventoryItemId = node.inventoryItem
    ? (node.inventoryItem as { id: string }).id
    : null;

  return {
    productId: productDbId,
    shopifyGid: node.id,
    shopifyId,
    title: node.title,
    sku: node.sku ?? null,
    gtin: node.barcode ?? null,
    mpn: meta.mpn ?? null,
    position: node.position ?? 1,
    weight: node.inventoryItem?.measurement?.weight?.value != null
      ? String(node.inventoryItem.measurement.weight.value)
      : null,
    weightUnit: node.inventoryItem?.measurement?.weight?.unit ?? null,
    requiresShipping: node.inventoryItem?.requiresShipping ?? true,
    taxable: node.taxable ?? true,
    available: node.availableForSale ?? false,
    inventoryItemId,
    metafieldOutlet: meta.outlet,
    metafieldExhibitionModel: meta.exhibitionModel,
    metafieldExhibitionStore: meta.exhibitionStore,
    metafieldBestseller: meta.bestseller,
    metafieldDiscontinued: meta.discontinued,
    metafieldShippingClass: meta.shippingClass,
    metafieldReturnClass: meta.returnClass,
    metafieldGoogleCategory: meta.googleCategory,
    metafieldMetaCategory: meta.metaCategory,
    metafieldMaterial: meta.material ?? [],
    metafieldStyle: meta.style ?? [],
    metafieldRoom: meta.room ?? [],
    metafieldIndoorOutdoor: meta.indoorOutdoor,
    metafieldLifestyleImageOverride: meta.lifestyleImageOverride,
    metafieldPrimaryImageOverride: meta.primaryImageOverride,
    rawMetafields: meta.raw as Record<string, string>,
    sourceUpdatedAt: null,
  };
}

function buildImageRows(
  nodes: BulkImageNode[],
  productDbId: string,
): ImageInsert[] {
  return nodes.map((img, idx) => ({
    productId: productDbId,
    shopifyGid: img.id,
    url: img.url,
    urlHash: hashUrl(img.url),
    altText: img.altText ?? null,
    position: idx + 1,
    width: (img.width as number | null) ?? null,
    height: (img.height as number | null) ?? null,
  }));
}

// ── Batch helper ──────────────────────────────────────────────────────────────

function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// ── Main sync ─────────────────────────────────────────────────────────────────

export async function syncProducts(
  client: ShopifyClient,
  tracker: SyncRunTracker,
  primaryLocale = "fr",
): Promise<void> {
  logger.info("Starting product sync via bulk operation");

  // Prefetch existing checksums to detect changes client-side
  const existingProducts = await db
    .select({
      shopifyGid: productsTable.shopifyGid,
      id: productsTable.id,
      checksum: productsTable.checksum,
    })
    .from(productsTable);

  const productMap = new Map(existingProducts.map((p) => [p.shopifyGid, p]));

  const existingVariants = await db
    .select({
      shopifyGid: variantsTable.shopifyGid,
      id: variantsTable.id,
      checksum: variantsTable.checksum,
      productId: variantsTable.productId,
    })
    .from(variantsTable);

  const variantMap = new Map(existingVariants.map((v) => [v.shopifyGid, v]));

  // Collect all bulk nodes in memory
  const products = new Map<string, BulkProductNode>();
  const variantsByProduct = new Map<string, BulkVariantNode[]>();
  const metafieldsByVariant = new Map<string, BulkMetafieldNode[]>();
  const imagesByProduct = new Map<string, BulkImageNode[]>();

  let nodeCount = 0;
  for await (const node of runBulkQuery<BulkNode>(client, BULK_PRODUCTS_QUERY)) {
    nodeCount++;
    tracker.bumpApiCalls();

    if (isProductNode(node)) {
      products.set(node.id, node as BulkProductNode);
    } else if (node.__parentId) {
      if (isVariantNode(node)) {
        const list = variantsByProduct.get(node.__parentId) ?? [];
        list.push(node as BulkVariantNode);
        variantsByProduct.set(node.__parentId, list);
      } else if (isMetafieldNode(node)) {
        const list = metafieldsByVariant.get(node.__parentId) ?? [];
        list.push(node as BulkMetafieldNode);
        metafieldsByVariant.set(node.__parentId, list);
      } else if (isImageNode(node)) {
        const list = imagesByProduct.get(node.__parentId) ?? [];
        list.push(node as BulkImageNode);
        imagesByProduct.set(node.__parentId, list);
      }
    }
  }

  logger.info(
    { products: products.size, totalNodes: nodeCount },
    "Bulk nodes collected",
  );
  tracker.bumpRead(products.size);

  // Process products in transactional batches of 25
  const productBatches = chunks([...products.entries()], 25);

  for (const [batchIdx, batch] of productBatches.entries()) {
    await db.transaction(async (tx) => {
      for (const [productGid, node] of batch) {
        // ── Product upsert ──────────────────────────────────────────────────
        const productFields = buildProductRow(node);
        const productChecksum = computeChecksum(productFields);
        const existing = productMap.get(productGid);
        let productDbId: string;

        if (!existing) {
          const [ins] = await tx
            .insert(productsTable)
            .values({ ...productFields, checksum: productChecksum })
            .returning({ id: productsTable.id });
          productDbId = ins!.id;
          tracker.bumpCreated();
          productMap.set(productGid, {
            shopifyGid: productGid,
            id: productDbId,
            checksum: productChecksum,
          });
        } else if (hasChanged(productChecksum, existing.checksum)) {
          await tx
            .update(productsTable)
            .set({ ...productFields, checksum: productChecksum, updatedAt: new Date() })
            .where(eq(productsTable.id, existing.id));
          productDbId = existing.id;
          tracker.bumpChanged();
          productMap.set(productGid, { ...existing, checksum: productChecksum });
        } else {
          productDbId = existing.id;
        }

        // ── Primary locale translation (title + description from Shopify base content) ─
        const titleTranslation: TranslationInsert = {
          productId: productDbId,
          language: primaryLocale,
          title: node.title,
          description: node.descriptionHtml ?? null,
          handle: node.handle,
        };
        await tx
          .insert(productTranslationsTable)
          .values(titleTranslation)
          .onConflictDoUpdate({
            target: [
              productTranslationsTable.productId,
              productTranslationsTable.language,
            ],
            set: {
              title: titleTranslation.title,
              description: titleTranslation.description,
              handle: titleTranslation.handle,
              updatedAt: new Date(),
            },
          });

        // ── Variant upserts ─────────────────────────────────────────────────
        const variants = variantsByProduct.get(productGid) ?? [];
        for (const vNode of variants) {
          const metas = metafieldsByVariant.get(vNode.id) ?? [];
          const variantFields = buildVariantRow(vNode, metas, productDbId);
          const variantChecksum = computeChecksum(variantFields);

          const existingV = variantMap.get(vNode.id);
          if (!existingV) {
            await tx
              .insert(variantsTable)
              .values({ ...variantFields, checksum: variantChecksum })
              .onConflictDoNothing();
            tracker.bumpCreated();
            variantMap.set(vNode.id, {
              shopifyGid: vNode.id,
              id: "_pending",
              checksum: variantChecksum,
              productId: productDbId,
            });
          } else if (hasChanged(variantChecksum, existingV.checksum)) {
            await tx
              .update(variantsTable)
              .set({
                ...variantFields,
                checksum: variantChecksum,
                updatedAt: new Date(),
              })
              .where(eq(variantsTable.shopifyGid, vNode.id));
            tracker.bumpChanged();
            variantMap.set(vNode.id, { ...existingV, checksum: variantChecksum });
          }
        }

        // ── Images: replace per product ─────────────────────────────────────
        // Always delete-and-reinsert for every product we see in the sync,
        // even if Shopify returned zero images (e.g. all images were removed).
        const imageNodes = imagesByProduct.get(productGid) ?? [];
        await tx
          .delete(imagesTable)
          .where(eq(imagesTable.productId, productDbId));
        if (imageNodes.length > 0) {
          const imageRows = buildImageRows(imageNodes, productDbId);
          await tx.insert(imagesTable).values(imageRows);
        }
      }
    });

    if ((batchIdx + 1) % 10 === 0) {
      const lastGid = batch[batch.length - 1]?.[0];
      await tracker.checkpoint({ lastProductGid: lastGid, batchIdx });
      logger.debug({ batchIdx, total: productBatches.length }, "Product sync progress");
    }
  }

  // Mark products not seen in this sync as archived (deleted from Shopify)
  const seenGids = [...products.keys()];
  if (seenGids.length > 0) {
    const archivedCount = await markDeletedProducts(seenGids);
    if (archivedCount > 0) {
      tracker.bumpDeleted(archivedCount);
      logger.info({ count: archivedCount }, "Products marked archived (not in Shopify bulk)");
    }
  }

  logger.info(tracker.getStats(), "Product sync complete");
}

/** Mark products in DB that were NOT returned by Shopify as archived. */
async function markDeletedProducts(seenGids: string[]): Promise<number> {
  // Only archive ACTIVE products that disappeared — don't touch already-archived
  const inDB = await db
    .select({ shopifyGid: productsTable.shopifyGid, id: productsTable.id })
    .from(productsTable)
    .where(eq(productsTable.status, "active"));

  const seenSet = new Set(seenGids);
  const disappeared = inDB.filter((p) => !seenSet.has(p.shopifyGid));

  if (disappeared.length === 0) return 0;

  await db
    .update(productsTable)
    .set({ status: "archived", updatedAt: new Date() })
    .where(
      inArray(
        productsTable.id,
        disappeared.map((p) => p.id),
      ),
    );

  return disappeared.length;
}

// ── Targeted single-product sync (used by webhook worker) ────────────────────

interface SingleProductResponse {
  product: {
    id: string;
    title: string;
    handle: string;
    descriptionHtml: string | null;
    vendor: string | null;
    productType: string | null;
    tags: string[];
    status: string;
    publishedAt: string | null;
    updatedAt: string;
    variants: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          sku: string | null;
          barcode: string | null;
          position: number;
          price: string;
          compareAtPrice: string | null;
          taxable: boolean;
          availableForSale: boolean;
          inventoryItem: {
            id: string;
            requiresShipping: boolean;
            measurement: { weight: { value: number; unit: string } | null } | null;
          } | null;
          metafields: { edges: Array<{ node: { id: string; namespace: string; key: string; value: string; type: string } }> };
        };
      }>;
    };
    // images intentionally omitted — fetched separately via fetchAllProductImages
    // to avoid the first:30 truncation that loses images for large products
  } | null;
}

export async function syncSingleProduct(
  client: ShopifyClient,
  shopifyProductGid: string,
  tracker?: SyncRunTracker,
  primaryLocale = "fr",
): Promise<void> {
  const result = await client.request<SingleProductResponse>(
    SINGLE_PRODUCT_QUERY,
    { id: shopifyProductGid },
    { expectedCost: 30 },
  );

  const product = result.product;
  if (!product) {
    logger.warn({ shopifyProductGid }, "Product not found on Shopify — marking archived");
    await db
      .update(productsTable)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(productsTable.shopifyGid, shopifyProductGid));
    return;
  }

  // Convert from edges format to BulkNode format
  const productNode: BulkProductNode = {
    id: product.id,
    title: product.title,
    handle: product.handle,
    descriptionHtml: product.descriptionHtml ?? null,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    status: product.status,
    publishedAt: product.publishedAt,
    updatedAt: product.updatedAt,
  };

  const variantNodes: BulkVariantNode[] = product.variants.edges.map(({ node: v }) => ({
    id: v.id,
    __parentId: product.id,
    title: v.title,
    sku: v.sku,
    barcode: v.barcode,
    position: v.position,
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    taxable: v.taxable,
    availableForSale: v.availableForSale,
    inventoryItem: v.inventoryItem,
  }));

  const metafieldsByVariant = new Map<string, BulkMetafieldNode[]>();
  for (const { node: v } of product.variants.edges) {
    const metas: BulkMetafieldNode[] = v.metafields.edges.map(({ node: m }) => ({
      id: m.id,
      __parentId: v.id,
      namespace: m.namespace,
      key: m.key,
      value: m.value,
      type: m.type,
    }));
    metafieldsByVariant.set(v.id, metas);
  }

  // Fetch ALL images via cursor pagination — avoids the first:30 cap in the
  // initial product query that would truncate and then delete images for
  // products with more than 30 photos.
  const imageNodes = await fetchAllProductImages(client, product.id);

  await db.transaction(async (tx) => {
    // Upsert product
    const productFields = buildProductRow(productNode);
    const productChecksum = computeChecksum(productFields);

    const [existing] = await tx
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(eq(productsTable.shopifyGid, product.id))
      .limit(1);

    let productDbId: string;
    if (!existing) {
      const [ins] = await tx
        .insert(productsTable)
        .values({ ...productFields, checksum: productChecksum })
        .returning({ id: productsTable.id });
      productDbId = ins!.id;
      tracker?.bumpCreated();
    } else {
      await tx
        .update(productsTable)
        .set({ ...productFields, checksum: productChecksum, updatedAt: new Date() })
        .where(eq(productsTable.id, existing.id));
      productDbId = existing.id;
      tracker?.bumpChanged();
    }

    // Primary locale translation (title + description from Shopify base content)
    await tx
      .insert(productTranslationsTable)
      .values({
        productId: productDbId,
        language: primaryLocale,
        title: product.title,
        description: product.descriptionHtml ?? null,
        handle: product.handle,
      })
      .onConflictDoUpdate({
        target: [productTranslationsTable.productId, productTranslationsTable.language],
        set: {
          title: product.title,
          description: product.descriptionHtml ?? null,
          handle: product.handle,
          updatedAt: new Date(),
        },
      });

    // Upsert variants
    for (const vNode of variantNodes) {
      const metas = metafieldsByVariant.get(vNode.id) ?? [];
      const variantFields = buildVariantRow(vNode, metas, productDbId);
      const variantChecksum = computeChecksum(variantFields);

      await tx
        .insert(variantsTable)
        .values({ ...variantFields, checksum: variantChecksum })
        .onConflictDoUpdate({
          target: variantsTable.shopifyGid,
          set: { ...variantFields, checksum: variantChecksum, updatedAt: new Date() },
        });
    }

    // Replace images — delete unconditionally so products that had all images
    // removed on Shopify don't retain stale rows that would be reclassified
    // and incorrectly surfaced in the feed.
    await tx.delete(imagesTable).where(eq(imagesTable.productId, productDbId));
    if (imageNodes.length > 0) {
      await tx.insert(imagesTable).values(buildImageRows(imageNodes, productDbId));
    }
  });

  tracker?.bumpRead(1);
  logger.info({ shopifyProductGid }, "Single product sync complete");
}
