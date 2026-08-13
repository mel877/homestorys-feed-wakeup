/**
 * Post-sync image classification runner.
 *
 * Downloads and classifies stored images that have not yet been classified
 * (isClassified = false). Updates imageType, whiteBgScore, solidBgScore,
 * alphaRatio columns in the DB.
 *
 * Called by the sync pipeline after products/images are written.
 * Also exposed as a standalone API route for manual re-runs.
 */

import { eq, isNull, or, and } from "drizzle-orm";
import { db, imagesTable } from "@workspace/db";
import { classifyImageUrl } from "./classifier";
import { logger as rootLogger } from "../lib/logger";

const logger = rootLogger.child({ module: "image-classifier" });

// Classification rate-limiter — avoid hammering CDN
const CLASSIFY_CONCURRENCY = 5;
const PAGE_SIZE = 50;

/**
 * Drain all unclassified images in paginated batches with bounded concurrency.
 * Loops until no more unclassified images remain.
 *
 * @param productId - if provided, only classify images for this product
 * @param signal    - optional AbortSignal for graceful shutdown
 */
export async function classifyStoredImages(options?: {
  productId?: string;
  signal?: AbortSignal;
}): Promise<{ classified: number; failed: number; pages: number }> {
  let classified = 0;
  let failed = 0;
  let pages = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (options?.signal?.aborted) break;

    // Build query for one page of unclassified images
    const condition = options?.productId
      ? and(
          eq(imagesTable.productId, options.productId),
          or(eq(imagesTable.isClassified, false), isNull(imagesTable.imageType)),
        )
      : or(eq(imagesTable.isClassified, false), isNull(imagesTable.imageType));

    const batch = await db
      .select({
        id: imagesTable.id,
        url: imagesTable.url,
        width: imagesTable.width,
        height: imagesTable.height,
      })
      .from(imagesTable)
      .where(condition)
      .limit(PAGE_SIZE);

    if (batch.length === 0) break; // no more unclassified images
    pages++;

    logger.debug(
      { page: pages, count: batch.length, productId: options?.productId },
      "Classifying image page",
    );

    // Process PAGE_SIZE images in CLASSIFY_CONCURRENCY chunks
    for (let i = 0; i < batch.length; i += CLASSIFY_CONCURRENCY) {
      if (options?.signal?.aborted) break;

      const chunk = batch.slice(i, i + CLASSIFY_CONCURRENCY);
      await Promise.all(
        chunk.map(async (img) => {
          try {
            const result = await classifyImageUrl(img.url);
            if (!result) {
              // classifyImageUrl returns null for transient failures (fetch error,
              // CDN 4xx/5xx, Sharp decode error). These are NOT confirmed-invalid
              // images — mark "unknown" so the feed can still use the image (position
              // order fallback) and it won't be permanently excluded.
              // "invalid" is reserved for confirmed bad content (imageType:"invalid"
              // returned by classifyImageBuffer when the image is too small).
              await db
                .update(imagesTable)
                .set({ imageType: "unknown", isClassified: true, classifiedAt: new Date(), updatedAt: new Date() })
                .where(eq(imagesTable.id, img.id));
              failed++;
              return;
            }

            await db
              .update(imagesTable)
              .set({
                imageType: result.imageType,
                whiteBgScore: String(result.whiteBgScore),
                solidBgScore: String(result.solidBgScore),
                alphaRatio: String(result.alphaRatio),
                edgeDensity: String(result.edgeDensity),
                variance: String(result.variance),
                resolutionScore: String(result.resolutionScore),
                isClassified: true,
                classifiedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(imagesTable.id, img.id));

            classified++;
          } catch (err) {
            logger.warn({ imageId: img.id, url: img.url, err }, "Image classification failed");
            await db
              .update(imagesTable)
              .set({ imageType: "unknown", isClassified: true, updatedAt: new Date() })
              .where(eq(imagesTable.id, img.id));
            failed++;
          }
        }),
      );
    }
  }

  logger.info({ classified, failed, pages }, "Image classification drain complete");
  return { classified, failed, pages };
}

/**
 * Re-classify all images for a specific product.
 * Resets classification state first, then drains until ALL product images are classified.
 * Called after single-product sync (webhook updates).
 */
export async function reclassifyProductImages(productId: string): Promise<void> {
  // Reset classification state so the drain loop picks them all up
  await db
    .update(imagesTable)
    .set({ isClassified: false, imageType: null, updatedAt: new Date() })
    .where(eq(imagesTable.productId, productId));

  // Drain until every image for this product is classified (no page limit)
  const result = await classifyStoredImages({ productId });
  logger.info({ productId, ...result }, "Product image reclassification complete");
}
