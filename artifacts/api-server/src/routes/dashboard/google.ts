import { Router, type IRouter } from "express";
import { db, feedItemsTable, feedSnapshotsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { eq, sql, and } from "drizzle-orm";

const router: IRouter = Router();

/**
 * GET /dashboard/google/status
 *
 * Returns current Google feed file snapshots and per-market feed item counts.
 * Google Merchant Center fetches these files via public URLs (file-fetch mode) —
 * no Content API push is performed by the tool.
 */
router.get("/dashboard/google/status", requireDashboardAuth, async (_req, res): Promise<void> => {
  const [snapshots, byMarket] = await Promise.all([
    // Current published feed files per market
    db.select()
      .from(feedSnapshotsTable)
      .where(
        and(
          eq(feedSnapshotsTable.channel, "google"),
          eq(feedSnapshotsTable.isCurrent, true),
        ),
      )
      .orderBy(feedSnapshotsTable.marketCode),
    // Feed item counts per market
    db.select({
      marketCode: feedItemsTable.marketCode,
      totalItems: sql<number>`count(*)::int`,
      eligibleItems: sql<number>`count(*) filter (where ${feedItemsTable.isEligible} = true)::int`,
    })
      .from(feedItemsTable)
      .where(eq(feedItemsTable.channel, "google"))
      .groupBy(feedItemsTable.marketCode)
      .orderBy(feedItemsTable.marketCode),
  ]);

  const lastGeneratedAt = snapshots.reduce<Date | null>((latest, s) => {
    if (!s.generatedAt) return latest;
    if (!latest) return s.generatedAt;
    return s.generatedAt > latest ? s.generatedAt : latest;
  }, null);

  res.json({
    lastGeneratedAt: lastGeneratedAt?.toISOString() ?? null,
    snapshots: snapshots.map((s) => ({
      marketCode: s.marketCode ?? null,
      language: s.language ?? null,
      publicUrl: `/api/feeds/google/market/${s.marketCode ?? ""}.tsv`,
      itemCount: s.itemCount ?? 0,
      sha256: s.sha256 ?? null,
      generatedAt: s.generatedAt?.toISOString() ?? "",
    })),
    byMarket: byMarket.map((m) => ({
      marketCode: m.marketCode,
      totalItems: m.totalItems,
      eligibleItems: m.eligibleItems,
    })),
  });
});

export default router;
