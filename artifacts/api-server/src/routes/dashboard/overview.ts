import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { sql, isNull, desc } from "drizzle-orm";
import {
  productsTable,
  variantsTable,
  marketVariantsTable,
  feedItemsTable,
  imagesTable,
  syncRunsTable,
  channelDiagnosticsTable,
  feedSnapshotsTable,
} from "@workspace/db";

const router: IRouter = Router();

router.get("/dashboard/overview", requireDashboardAuth, async (req, res): Promise<void> => {
  const [
    productCount,
    variantCount,
    eligibleCount,
    byMarket,
    byAvailability,
    recentRuns,
    activeAlerts,
    avgQuality,
    below70,
    imageCounts,
    lastFullSync,
    lastGooglePush,
    lastMetaPush,
  ] = await Promise.all([
    // Total products
    db.select({ count: sql<number>`count(*)::int` }).from(productsTable),
    // Total variants
    db.select({ count: sql<number>`count(*)::int` }).from(variantsTable),
    // Eligible variants (any market)
    db.select({ count: sql<number>`count(distinct ${marketVariantsTable.variantId})::int` })
      .from(marketVariantsTable)
      .where(sql`${marketVariantsTable.isEligible} = true`),
    // By market
    db.select({
      marketCode: marketVariantsTable.marketCode,
      totalVariants: sql<number>`count(*)::int`,
      eligibleVariants: sql<number>`sum(case when ${marketVariantsTable.isEligible} then 1 else 0 end)::int`,
    })
      .from(marketVariantsTable)
      .groupBy(marketVariantsTable.marketCode)
      .orderBy(marketVariantsTable.marketCode),
    // By availability
    db.select({
      availability: marketVariantsTable.availability,
      count: sql<number>`count(*)::int`,
    })
      .from(marketVariantsTable)
      .groupBy(marketVariantsTable.availability),
    // Recent sync runs
    db.select().from(syncRunsTable).orderBy(desc(syncRunsTable.startedAt)).limit(10),
    // Active unresolved diagnostics grouped by type
    db.select({
      type: channelDiagnosticsTable.issueType,
      severity: channelDiagnosticsTable.severity,
      message: sql<string>`max(${channelDiagnosticsTable.message})`,
      count: sql<number>`count(*)::int`,
    })
      .from(channelDiagnosticsTable)
      .where(isNull(channelDiagnosticsTable.resolvedAt))
      .groupBy(channelDiagnosticsTable.issueType, channelDiagnosticsTable.severity)
      .orderBy(desc(sql`count(*)`))
      .limit(20),
    // Avg quality score
    db.select({ avg: sql<number | null>`avg(${feedItemsTable.dataQualityScore})::numeric` }).from(feedItemsTable),
    // Variants below 70
    db.select({ count: sql<number>`count(distinct ${feedItemsTable.variantId})::int` })
      .from(feedItemsTable)
      .where(sql`${feedItemsTable.dataQualityScore} < 70`),
    // Image counts
    db.select({
      total: sql<number>`count(*)::int`,
      classified: sql<number>`sum(case when ${imagesTable.isClassified} then 1 else 0 end)::int`,
      productsWithImages: sql<number>`count(distinct ${imagesTable.productId})::int`,
    }).from(imagesTable),
    // Last full sync
    db.select({ startedAt: syncRunsTable.startedAt })
      .from(syncRunsTable)
      .where(sql`${syncRunsTable.runType} = 'full' and ${syncRunsTable.status} = 'completed'`)
      .orderBy(desc(syncRunsTable.startedAt))
      .limit(1),
    // Last Google push (feed snapshot)
    db.select({ generatedAt: feedSnapshotsTable.generatedAt })
      .from(feedSnapshotsTable)
      .where(sql`${feedSnapshotsTable.channel} = 'google'`)
      .orderBy(desc(feedSnapshotsTable.generatedAt))
      .limit(1),
    // Last Meta push (feed snapshot)
    db.select({ generatedAt: feedSnapshotsTable.generatedAt })
      .from(feedSnapshotsTable)
      .where(sql`${feedSnapshotsTable.channel} = 'meta'`)
      .orderBy(desc(feedSnapshotsTable.generatedAt))
      .limit(1),
  ]);

  res.json({
    totalProducts: productCount[0]?.count ?? 0,
    totalVariants: variantCount[0]?.count ?? 0,
    eligibleVariants: eligibleCount[0]?.count ?? 0,
    byMarket,
    byAvailability,
    recentRuns: recentRuns.map((r) => ({
      id: r.id,
      runType: r.runType,
      status: r.status,
      startedAt: r.startedAt?.toISOString() ?? "",
      finishedAt: r.finishedAt?.toISOString() ?? null,
      durationMs: r.durationMs ?? null,
      recordsRead: r.recordsRead ?? 0,
      recordsChanged: r.recordsChanged ?? 0,
      errors: r.errors ?? 0,
      warnings: r.warnings ?? 0,
    })),
    activeAlerts: activeAlerts.map((a) => ({
      type: a.type,
      severity: a.severity,
      message: a.message,
      count: a.count,
    })),
    feedHealth: {
      avgDataQualityScore: avgQuality[0]?.avg != null ? Number(avgQuality[0].avg) : null,
      variantsBelow70: below70[0]?.count ?? 0,
      classifiedImages: imageCounts[0]?.classified ?? 0,
      totalImages: imageCounts[0]?.total ?? 0,
      productsWithImages: imageCounts[0]?.productsWithImages ?? 0,
      productsWithoutImages: Math.max(0, (productCount[0]?.count ?? 0) - (imageCounts[0]?.productsWithImages ?? 0)),
      lastFullSync: lastFullSync[0]?.startedAt?.toISOString() ?? null,
      lastGooglePush: lastGooglePush[0]?.generatedAt?.toISOString() ?? null,
      lastMetaPush: lastMetaPush[0]?.generatedAt?.toISOString() ?? null,
    },
  });
});

export default router;
