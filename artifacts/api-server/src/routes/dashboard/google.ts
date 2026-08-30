import { Router, type IRouter } from "express";
import { db, feedSnapshotsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

/**
 * GET /dashboard/google/status
 *
 * Returns current Google feed file snapshots and their published item counts.
 * Google Merchant Center fetches these files via public URLs (file-fetch mode) —
 * no Content API push is performed by the tool.
 */
router.get("/dashboard/google/status", requireDashboardAuth, async (_req, res): Promise<void> => {
  const snapshots = await db.select()
    .from(feedSnapshotsTable)
    .where(
      and(
        eq(feedSnapshotsTable.channel, "google"),
        eq(feedSnapshotsTable.isCurrent, true),
      ),
    )
    .orderBy(feedSnapshotsTable.marketCode);

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
    // The former eligibility summary came from live feed_items rather than the
    // published files. Hide it until it can be represented without mixing data
    // sources or fabricating an eligibility denominator.
    byMarket: [],
  });
});

export default router;
