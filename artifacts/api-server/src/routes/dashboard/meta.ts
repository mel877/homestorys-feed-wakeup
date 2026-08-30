import { Router, type IRouter } from "express";
import { db, feedSnapshotsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { and, eq, inArray } from "drizzle-orm";

const router: IRouter = Router();

const DURABLE_META_IDENTITIES = [
  "BASE",
  "AT",
  "BE",
  "CH",
  "DE",
  "FR",
  "LU",
  "META_LANGUAGE_FR",
  "META_LANGUAGE_DE",
] as const;

router.get("/dashboard/meta/status", requireDashboardAuth, async (_req, res): Promise<void> => {
  const feeds = await db.select()
    .from(feedSnapshotsTable)
    .where(
      and(
        eq(feedSnapshotsTable.channel, "meta"),
        eq(feedSnapshotsTable.isCurrent, true),
        inArray(feedSnapshotsTable.marketCode, DURABLE_META_IDENTITIES),
      ),
    )
    .orderBy(feedSnapshotsTable.marketCode);

  const lastPushAt = feeds.reduce<Date | null>((latest, feed) => {
    if (!feed.generatedAt) return latest;
    if (!latest || feed.generatedAt > latest) return feed.generatedAt;
    return latest;
  }, null);

  res.json({
    lastPushAt: lastPushAt?.toISOString() ?? null,
    feeds: feeds.map((f) => ({
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
