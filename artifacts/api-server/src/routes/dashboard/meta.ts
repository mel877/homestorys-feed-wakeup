import { Router, type IRouter } from "express";
import { db, feedSnapshotsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { eq, desc, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/dashboard/meta/status", requireDashboardAuth, async (_req, res): Promise<void> => {
  const [lastPush, feeds] = await Promise.all([
    db.select({ generatedAt: feedSnapshotsTable.generatedAt })
      .from(feedSnapshotsTable)
      .where(eq(feedSnapshotsTable.channel, "meta"))
      .orderBy(desc(feedSnapshotsTable.generatedAt))
      .limit(1),
    db.select().from(feedSnapshotsTable)
      .where(eq(feedSnapshotsTable.channel, "meta"))
      .orderBy(feedSnapshotsTable.language, feedSnapshotsTable.marketCode, desc(feedSnapshotsTable.generatedAt)),
  ]);

  // Deduplicate: keep only the most recent snapshot per language+marketCode combo
  const seen = new Set<string>();
  const dedupedFeeds = feeds.filter((f) => {
    const key = `${f.language ?? ""}:${f.marketCode ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  res.json({
    lastPushAt: lastPush[0]?.generatedAt?.toISOString() ?? null,
    feeds: dedupedFeeds.map((f) => ({
      language: f.language ?? "",
      marketCode: f.marketCode ?? null,
      itemCount: f.itemCount ?? 0,
      generatedAt: f.generatedAt?.toISOString() ?? "",
      isCurrent: f.isCurrent ?? false,
      storagePath: f.storagePath ?? null,
      downloadUrl: f.storagePath ? `/api/feeds/meta/${f.storagePath.split("/").pop() ?? ""}` : null,
    })),
  });
});

export default router;
