import { Router, type IRouter } from "express";
import { db, feedItemsTable, productsTable, variantsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { GetDataQualityQueryParams } from "@workspace/api-zod";
import { eq, sql, and, desc } from "drizzle-orm";

const router: IRouter = Router();

const BUCKETS = [
  { label: "0–20", minScore: 0, maxScore: 20 },
  { label: "21–40", minScore: 21, maxScore: 40 },
  { label: "41–60", minScore: 41, maxScore: 60 },
  { label: "61–70", minScore: 61, maxScore: 70 },
  { label: "71–80", minScore: 71, maxScore: 80 },
  { label: "81–90", minScore: 81, maxScore: 90 },
  { label: "91–100", minScore: 91, maxScore: 100 },
];

router.get("/dashboard/data-quality", requireDashboardAuth, async (req, res): Promise<void> => {
  const params = GetDataQualityQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { threshold = 70, market, limit = 100 } = params.data;

  const marketCondition = market ? eq(feedItemsTable.marketCode, market) : undefined;

  const [avgRows, totalRows, belowThresholdRows, lowQualityRows] = await Promise.all([
    db.select({ avg: sql<number | null>`avg(${feedItemsTable.dataQualityScore})::numeric` })
      .from(feedItemsTable)
      .where(marketCondition),
    db.select({ count: sql<number>`count(*)::int` })
      .from(feedItemsTable)
      .where(and(
        sql`${feedItemsTable.dataQualityScore} is not null`,
        marketCondition,
      )),
    db.select({ count: sql<number>`count(*)::int` })
      .from(feedItemsTable)
      .where(and(
        sql`${feedItemsTable.dataQualityScore} <= ${threshold}`,
        marketCondition,
      )),
    db.select({
      productId: productsTable.id,
      handle: productsTable.handle,
      variantId: feedItemsTable.variantId,
      marketCode: feedItemsTable.marketCode,
      language: feedItemsTable.language,
      score: feedItemsTable.dataQualityScore,
      exclusionReason: feedItemsTable.exclusionReason,
    })
      .from(feedItemsTable)
      .leftJoin(variantsTable, eq(variantsTable.id, feedItemsTable.variantId))
      .leftJoin(productsTable, eq(productsTable.id, variantsTable.productId))
      .where(and(
        sql`${feedItemsTable.dataQualityScore} is not null and ${feedItemsTable.dataQualityScore} <= ${threshold}`,
        marketCondition,
      ))
      .orderBy(feedItemsTable.dataQualityScore)
      .limit(limit ?? 100),
  ]);

  // Compute distribution buckets
  const distribution = await Promise.all(
    BUCKETS.map(async (bucket) => {
      const [row] = await db.select({ count: sql<number>`count(*)::int` })
        .from(feedItemsTable)
        .where(and(
          sql`${feedItemsTable.dataQualityScore} >= ${bucket.minScore} and ${feedItemsTable.dataQualityScore} <= ${bucket.maxScore}`,
          marketCondition,
        ));
      return { ...bucket, count: row?.count ?? 0 };
    })
  );

  res.json({
    avgScore: avgRows[0]?.avg != null ? Number(avgRows[0].avg) : null,
    totalVariants: totalRows[0]?.count ?? 0,
    variantsBelowThreshold: belowThresholdRows[0]?.count ?? 0,
    distribution,
    lowQualityProducts: lowQualityRows.map((r) => ({
      productId: r.productId ?? "",
      handle: r.handle ?? "",
      variantId: r.variantId,
      marketCode: r.marketCode,
      language: r.language,
      score: r.score != null ? Number(r.score) : 0,
      exclusionReason: r.exclusionReason ?? null,
    })),
  });
});

export default router;
