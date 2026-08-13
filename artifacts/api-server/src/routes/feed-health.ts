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
import { eq, desc, count, and, gte, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getActiveAlerts } from "../observability/alerts";

const router: IRouter = Router();

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
      return [];
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

export default router;
