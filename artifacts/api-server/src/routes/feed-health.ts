import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { syncRunsTable, feedItemsTable } from "@workspace/db";
import { eq, desc, count } from "drizzle-orm";

const router: IRouter = Router();

/**
 * GET /api/feed-health
 *
 * Returns aggregated KPIs for the feed health dashboard.
 * All values are computed from the DB — no live Shopify calls.
 */
router.get("/feed-health", async (req, res) => {
  try {
    // Last sync run per type
    const lastRuns = await db
      .select({
        runType: syncRunsTable.runType,
        status: syncRunsTable.status,
        startedAt: syncRunsTable.startedAt,
        finishedAt: syncRunsTable.finishedAt,
        recordsRead: syncRunsTable.recordsRead,
        errors: syncRunsTable.errors,
      })
      .from(syncRunsTable)
      .orderBy(desc(syncRunsTable.startedAt))
      .limit(20);

    // Product counts by eligibility
    const eligibilityCounts = await db
      .select({
        isEligible: feedItemsTable.isEligible,
        channel: feedItemsTable.channel,
        total: count(),
      })
      .from(feedItemsTable)
      .groupBy(feedItemsTable.isEligible, feedItemsTable.channel);

    // Counts by market
    const marketCounts = await db
      .select({
        marketCode: feedItemsTable.marketCode,
        channel: feedItemsTable.channel,
        total: count(),
      })
      .from(feedItemsTable)
      .where(eq(feedItemsTable.isEligible, true))
      .groupBy(feedItemsTable.marketCode, feedItemsTable.channel);

    res.json({
      lastRuns,
      eligibilityCounts,
      marketCounts,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch feed health");
    res.status(500).json({ error: "Failed to fetch feed health" });
  }
});

export default router;
