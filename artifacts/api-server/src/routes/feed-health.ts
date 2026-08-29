/**
 * GET /api/feed-health
 *
 * Returns all KPIs from spec §41 computed from the DB:
 *   - Last sync runs per type (full / inventory / prices / recommendations)
 *   - Feed snapshot freshness per channel (google / meta)
 *   - Product eligibility counts per channel
 *   - Product counts by market
 *   - Active alerts (from sync_errors in last 24h)
 *   - Overall health status
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  syncRunsTable,
  feedItemsTable,
  feedSnapshotsTable,
  syncErrorsTable,
} from "@workspace/db";
import { eq, desc, count, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getActiveAlerts } from "../observability/alerts";
import { getFeedFileMetadata } from "../lib/storage";
import { requireDashboardAuth } from "./dashboard/auth";

const router: IRouter = Router();

type CurrentFeedSnapshot = {
  channel: string;
  language: string | null;
  marketCode: string | null;
  storagePath: string;
  itemCount: number;
  generatedAt: Date;
  sha256: string | null;
};

export function publicFeedPathForSnapshot(snapshot: CurrentFeedSnapshot): string | null {
  const filename = snapshot.storagePath.split("/").pop() ?? "";

  if (snapshot.channel === "showroom") {
    if (filename === "google-eupen.tsv") return "/api/feeds/google/showroom/eupen.tsv";
    if (filename === "meta-eupen.csv") return "/api/feeds/meta/showroom/eupen.csv";
    return `/api/feeds/showroom/${filename}`;
  }

  if (snapshot.channel === "google") {
    if (/^google-[a-z]{2}\.tsv$/i.test(filename) && snapshot.language) {
      return `/api/feeds/google/${snapshot.language.toLowerCase()}.tsv`;
    }
    if (snapshot.marketCode && !snapshot.marketCode.startsWith("LANG_")) {
      return `/api/feeds/google/market/${snapshot.marketCode}.tsv`;
    }
    return null;
  }

  if (snapshot.channel === "meta") {
    if (filename === "meta-base.csv") return "/api/feeds/meta/base.csv";
    const languageMatch = filename.match(/^meta-language-([a-z]{2})\.csv$/i);
    if (languageMatch?.[1]) return `/api/feeds/meta/lang/${languageMatch[1].toLowerCase()}.csv`;
    const countryMatch = filename.match(/^meta-country-([a-z]{2})\.csv$/i);
    if (countryMatch?.[1]) return `/api/feeds/meta/country/${countryMatch[1].toUpperCase()}.csv`;
    const stableLanguageMatch = filename.match(/^meta-([a-z]{2})\.csv$/i);
    if (stableLanguageMatch?.[1]) return `/api/feeds/meta/${stableLanguageMatch[1].toLowerCase()}.csv`;
    return `/api/feeds/meta/${filename}`;
  }

  return null;
}

function requestOrigin(req: Parameters<Parameters<typeof router.get>[1]>[0]): string {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
    ?.split(",")[0]
    ?.trim() || req.protocol;
  return `${proto}://${req.get("host")}`;
}

/**
 * GET /api/feed-health
 *
 * Returns aggregated KPIs for the feed health dashboard.
 * All values are computed from the DB — no live Shopify calls.
 */
router.get("/feed-health", async (req, res) => {
  try {
    // ── 1. Last sync run per type ───────────────────────────────────────────
    const allRecentRuns = await db
      .select({
        runType: syncRunsTable.runType,
        status: syncRunsTable.status,
        startedAt: syncRunsTable.startedAt,
        finishedAt: syncRunsTable.finishedAt,
        durationMs: syncRunsTable.durationMs,
        recordsRead: syncRunsTable.recordsRead,
        recordsChanged: syncRunsTable.recordsChanged,
        recordsCreated: syncRunsTable.recordsCreated,
        errors: syncRunsTable.errors,
        warnings: syncRunsTable.warnings,
        apiCalls: syncRunsTable.apiCalls,
        id: syncRunsTable.id,
      })
      .from(syncRunsTable)
      .orderBy(desc(syncRunsTable.startedAt))
      .limit(50);

    // Deduplicate: keep only the latest run per type, returned as an array
    const lastRunByType = new Map<string, typeof allRecentRuns[0]>();
    for (const run of allRecentRuns) {
      if (!lastRunByType.has(run.runType)) {
        lastRunByType.set(run.runType, run);
      }
    }
    const lastRuns = Array.from(lastRunByType.values());

    // ── 2. Feed snapshot freshness ──────────────────────────────────────────
    const currentSnapshots = await db
      .select({
        channel: feedSnapshotsTable.channel,
        language: feedSnapshotsTable.language,
        marketCode: feedSnapshotsTable.marketCode,
        storagePath: feedSnapshotsTable.storagePath,
        itemCount: feedSnapshotsTable.itemCount,
        generatedAt: feedSnapshotsTable.generatedAt,
        sha256: feedSnapshotsTable.sha256,
      })
      .from(feedSnapshotsTable)
      .where(eq(feedSnapshotsTable.isCurrent, true))
      .orderBy(desc(feedSnapshotsTable.generatedAt));

    // Summarise per channel
    const snapshotsByChannel: Record<
      string,
      {
        latestGeneratedAt: string | null;
        totalItems: number;
        fileCount: number;
        ageMinutes: number | null;
      }
    > = {};
    for (const snap of currentSnapshots) {
      const ch = snap.channel;
      if (!snapshotsByChannel[ch]) {
        snapshotsByChannel[ch] = {
          latestGeneratedAt: null,
          totalItems: 0,
          fileCount: 0,
          ageMinutes: null,
        };
      }
      const entry = snapshotsByChannel[ch]!;
      entry.fileCount++;
      entry.totalItems += snap.itemCount;
      if (!entry.latestGeneratedAt || snap.generatedAt.toISOString() > entry.latestGeneratedAt) {
        entry.latestGeneratedAt = snap.generatedAt.toISOString();
        const ageMs = Date.now() - snap.generatedAt.getTime();
        entry.ageMinutes = Math.round(ageMs / 60_000);
      }
    }

    // ── 3. Product eligibility counts ───────────────────────────────────────
    const eligibilityCounts = await db
      .select({
        isEligible: feedItemsTable.isEligible,
        channel: feedItemsTable.channel,
        total: count(),
      })
      .from(feedItemsTable)
      .groupBy(feedItemsTable.isEligible, feedItemsTable.channel);

    // ── 4. Counts by market ─────────────────────────────────────────────────
    const marketCounts = await db
      .select({
        marketCode: feedItemsTable.marketCode,
        channel: feedItemsTable.channel,
        total: count(),
      })
      .from(feedItemsTable)
      .where(eq(feedItemsTable.isEligible, true))
      .groupBy(feedItemsTable.marketCode, feedItemsTable.channel);

    // ── 5. Active alerts ────────────────────────────────────────────────────
    const activeAlerts = await getActiveAlerts().catch((err) => {
      logger.warn({ err }, "Failed to fetch active alerts — returning empty list");
      return [] as Awaited<ReturnType<typeof getActiveAlerts>>;
    });

    // ── 6. Overall health status ────────────────────────────────────────────
    const hasCritical = activeAlerts.some((a) => a.severity === "critical");
    const hasWarning = activeAlerts.some((a) => a.severity === "warning");
    const overallStatus = hasCritical ? "critical" : hasWarning ? "warning" : "healthy";

    // ── 7. Sync pipeline summary ─────────────────────────────────────────────
    const syncSummary: Record<string, {
      status: string | null;
      lastRunAt: string | null;
      lastRunDurationMs: number | null;
    }> = {};
    for (const run of lastRuns) {
      syncSummary[run.runType] = {
        status: run.status,
        lastRunAt: run.startedAt?.toISOString() ?? null,
        lastRunDurationMs: run.durationMs ?? null,
      };
    }

    res.json({
      overallStatus,
      activeAlerts,
      syncSummary,
      lastRuns,
      feedSnapshots: snapshotsByChannel,
      eligibilityCounts,
      marketCounts,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch feed health");
    req.log?.error({ err }, "Failed to fetch feed health");
    res.status(500).json({ error: "Failed to fetch feed health" });
  }
});

/**
 * GET /api/dashboard/feed-health/files
 *
 * Protected per-file operational status. File bodies remain public, while
 * storage diagnostics and error messages require a dashboard session.
 */
router.get(
  "/dashboard/feed-health/files",
  requireDashboardAuth,
  async (req, res): Promise<void> => {
    try {
      const [snapshots, recentErrors] = await Promise.all([
        db
          .select({
            channel: feedSnapshotsTable.channel,
            language: feedSnapshotsTable.language,
            marketCode: feedSnapshotsTable.marketCode,
            storagePath: feedSnapshotsTable.storagePath,
            itemCount: feedSnapshotsTable.itemCount,
            generatedAt: feedSnapshotsTable.generatedAt,
            sha256: feedSnapshotsTable.sha256,
          })
          .from(feedSnapshotsTable)
          .where(eq(feedSnapshotsTable.isCurrent, true))
          .orderBy(feedSnapshotsTable.channel, feedSnapshotsTable.marketCode),
        db
          .select({
            errorType: syncErrorsTable.errorType,
            entityType: syncErrorsTable.entityType,
            entityId: syncErrorsTable.entityId,
            message: syncErrorsTable.message,
            createdAt: syncErrorsTable.createdAt,
          })
          .from(syncErrorsTable)
          .where(inArray(syncErrorsTable.entityType, ["channel", "feed"]))
          .orderBy(desc(syncErrorsTable.createdAt))
          .limit(100),
      ]);

      const origin = requestOrigin(req);
      const feeds = await Promise.all(
        snapshots.map(async (snapshot) => {
          const publicPath = publicFeedPathForSnapshot(snapshot);
          const matchingError = recentErrors.find((error) =>
            error.entityId === snapshot.channel
            || (snapshot.channel === "showroom" && error.entityId === "showroom")
            || error.entityId === snapshot.marketCode
            || error.entityId === snapshot.storagePath,
          );

          try {
            const metadata = await getFeedFileMetadata(snapshot.storagePath);
            const exists = metadata !== null;
            return {
              channel: snapshot.channel,
              language: snapshot.language,
              marketCode: snapshot.marketCode,
              format: snapshot.storagePath.endsWith(".tsv") ? "tsv" : "csv",
              publicUrl: publicPath ? new URL(publicPath, origin).toString() : null,
              status: exists ? "healthy" : "missing",
              itemCount: snapshot.itemCount,
              generatedAt: snapshot.generatedAt.toISOString(),
              sizeBytes: metadata?.size ?? null,
              valid: exists && Boolean(snapshot.sha256),
              validationStatus: snapshot.sha256 ? "passed_at_publish" : "unknown",
              lastError: matchingError
                ? {
                    type: matchingError.errorType,
                    message: matchingError.message.slice(0, 500),
                    occurredAt: matchingError.createdAt.toISOString(),
                  }
                : null,
            };
          } catch {
            return {
              channel: snapshot.channel,
              language: snapshot.language,
              marketCode: snapshot.marketCode,
              format: snapshot.storagePath.endsWith(".tsv") ? "tsv" : "csv",
              publicUrl: publicPath ? new URL(publicPath, origin).toString() : null,
              status: "storage_error",
              itemCount: snapshot.itemCount,
              generatedAt: snapshot.generatedAt.toISOString(),
              sizeBytes: null,
              valid: null,
              validationStatus: snapshot.sha256 ? "passed_at_publish" : "unknown",
              lastError: {
                type: "storage_metadata_failed",
                message: "Unable to read feed object metadata",
                occurredAt: new Date().toISOString(),
              },
            };
          }
        }),
      );

      res.json({
        status: feeds.every((feed) => feed.status === "healthy") ? "healthy" : "degraded",
        generatedAt: new Date().toISOString(),
        feeds,
      });
    } catch (err) {
      logger.error({ err }, "Failed to fetch per-file feed health");
      res.status(500).json({ error: "Failed to fetch feed file health" });
    }
  },
);

export default router;
