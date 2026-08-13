import { Router, type IRouter } from "express";
import { db, imagesTable, productsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { ListImageAnalysisQueryParams } from "@workspace/api-zod";
import { eq, sql, and, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/dashboard/images", requireDashboardAuth, async (req, res): Promise<void> => {
  const params = ListImageAnalysisQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { productId, imageType, classified, limit = 50, offset = 0 } = params.data;

  const conditions = [];
  if (productId) conditions.push(eq(imagesTable.productId, productId));
  if (imageType) conditions.push(eq(imagesTable.imageType!, imageType));
  if (classified != null) conditions.push(eq(imagesTable.isClassified, classified));

  const [rows, countRows] = await Promise.all([
    db.select({
      id: imagesTable.id,
      url: imagesTable.url,
      productId: imagesTable.productId,
      variantId: imagesTable.variantId,
      position: imagesTable.position,
      imageType: imagesTable.imageType,
      width: imagesTable.width,
      height: imagesTable.height,
      whiteBgScore: imagesTable.whiteBgScore,
      solidBgScore: imagesTable.solidBgScore,
      alphaRatio: imagesTable.alphaRatio,
      edgeDensity: imagesTable.edgeDensity,
      resolutionScore: imagesTable.resolutionScore,
      isClassified: imagesTable.isClassified,
      productHandle: productsTable.handle,
    })
      .from(imagesTable)
      .leftJoin(productsTable, eq(productsTable.id, imagesTable.productId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(imagesTable.updatedAt))
      .limit(limit ?? 50)
      .offset(offset ?? 0),
    db.select({ count: sql<number>`count(*)::int` })
      .from(imagesTable)
      .where(conditions.length ? and(...conditions) : undefined),
  ]);

  res.json({
    items: rows.map((img) => ({
      id: img.id,
      url: img.url,
      productId: img.productId,
      productHandle: img.productHandle ?? null,
      variantId: img.variantId ?? null,
      position: img.position ?? 1,
      imageType: img.imageType ?? null,
      width: img.width ?? null,
      height: img.height ?? null,
      whiteBgScore: img.whiteBgScore != null ? Number(img.whiteBgScore) : null,
      solidBgScore: img.solidBgScore != null ? Number(img.solidBgScore) : null,
      alphaRatio: img.alphaRatio != null ? Number(img.alphaRatio) : null,
      edgeDensity: img.edgeDensity != null ? Number(img.edgeDensity) : null,
      resolutionScore: img.resolutionScore != null ? Number(img.resolutionScore) : null,
      isClassified: img.isClassified ?? false,
      selectionReason: img.imageType ?? null,
    })),
    total: countRows[0]?.count ?? 0,
  });
});

export default router;
