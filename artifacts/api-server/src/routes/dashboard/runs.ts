import { Router, type IRouter } from "express";
import { db, syncRunsTable, syncErrorsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { ListSyncRunsQueryParams, GetSyncRunParams, TriggerSyncBody } from "@workspace/api-zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { tryAcquireLock, releaseLock } from "../../jobs/scheduler";
import type { SyncRunType } from "../../shopify/sync-run-tracker";

/** Map dashboard runType to scheduler job name and SyncRunType. */
const JOB_MAP: Record<string, { jobName: string; runType: SyncRunType }> = {
  full: { jobName: "full-sync", runType: "full" },
  inventory: { jobName: "inventory-sync", runType: "inventory" },
  prices: { jobName: "price-sync", runType: "prices" },
  recommendations: { jobName: "recommendations-sync", runType: "recommendations" },
  // Feed export only (Google + Meta) — regenerates channel feeds from the
  // already-synced canonical data without re-running the full Shopify sync.
  export: { jobName: "feed-export", runType: "export" },
};

const router: IRouter = Router();

router.get("/dashboard/sync-runs", requireDashboardAuth, async (req, res): Promise<void> => {
  const params = ListSyncRunsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { runType, status, limit = 50, offset = 0 } = params.data;

  const conditions = [];
  if (runType) conditions.push(eq(syncRunsTable.runType, runType));
  if (status) conditions.push(eq(syncRunsTable.status, status));

  const [rows, countRows] = await Promise.all([
    db.select().from(syncRunsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(syncRunsTable.startedAt))
      .limit(limit ?? 50)
      .offset(offset ?? 0),
    db.select({ count: sql<number>`count(*)::int` }).from(syncRunsTable)
      .where(conditions.length ? and(...conditions) : undefined),
  ]);

  res.json({
    items: rows.map((r) => ({
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
    total: countRows[0]?.count ?? 0,
  });
});

router.get("/dashboard/sync-runs/trigger", requireDashboardAuth, async (_req, res): Promise<void> => {
  // Placeholder to avoid Express routing conflict with /:id
  res.status(405).json({ error: "Use POST /dashboard/sync-runs/trigger" });
});

router.get("/dashboard/sync-runs/:id", requireDashboardAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetSyncRunParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [run] = await db.select().from(syncRunsTable).where(eq(syncRunsTable.id, params.data.id));
  if (!run) {
    res.status(404).json({ error: "Sync run not found" });
    return;
  }

  const errors = await db.select().from(syncErrorsTable)
    .where(eq(syncErrorsTable.syncRunId, run.id))
    .orderBy(desc(syncErrorsTable.createdAt))
    .limit(200);

  res.json({
    run: {
      id: run.id,
      runType: run.runType,
      status: run.status,
      startedAt: run.startedAt?.toISOString() ?? "",
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs: run.durationMs ?? null,
      recordsRead: run.recordsRead ?? 0,
      recordsChanged: run.recordsChanged ?? 0,
      errors: run.errors ?? 0,
      warnings: run.warnings ?? 0,
    },
    errors: errors.map((e) => ({
      id: e.id,
      errorType: e.errorType,
      entityType: e.entityType ?? null,
      entityId: e.entityId ?? null,
      marketCode: e.marketCode ?? null,
      message: e.message,
      details: e.details ?? null,
      createdAt: e.createdAt?.toISOString() ?? "",
    })),
  });
});

router.post("/dashboard/sync-runs/trigger", requireDashboardAuth, async (req, res): Promise<void> => {
  const parsed = TriggerSyncBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { runType } = parsed.data;
  const job = JOB_MAP[runType];
  if (!job) {
    res.status(400).json({ error: `Unknown runType: ${runType}` });
    return;
  }

  // Atomically acquire the scheduler lock BEFORE sending 202.
  // tryAcquireLock does a synchronous in-process check (Node.js single-threaded) and
  // an async DB check for process-restart orphans. If the lock is taken by the
  // scheduler or a concurrent request, we return 409 without dispatching anything.
  const lock = await tryAcquireLock(job.jobName, job.runType);
  if (!lock.acquired) {
    res.status(409).json({ error: `A ${runType} sync is already running` });
    return;
  }

  // Lock acquired — respond 202 immediately and run the job in the background.
  // The background job owns the already-held lock and MUST release it in finally.
  res.status(202).json({ runType, status: "dispatched" });

  setImmediate(() => {
    const runBackground = async (): Promise<void> => {
      let runId: string | null = null;
      try {
        logger.info({ job: job.jobName }, "Dashboard trigger: job starting");

        if (runType === "full") {
          const { runFullSync } = await import("../../shopify/index");
          const { runGoogleExport } = await import("../../exporters/google/runner");
          const { runMetaExport } = await import("../../exporters/meta/generator");
          const { fetchAndStoreDiagnostics } = await import("../../exporters/google/diagnostics");
          const { withExportLock } = await import("../../exporters/export-lock");
          // Complete full-sync pipeline, matching the scheduler exactly.
          runId = await runFullSync();
          // Serialized behind the shared feed-export lock (never overlaps a
          // standalone export publish).
          const capturedFullRunId = runId;
          await withExportLock(async () => {
            await runGoogleExport({ syncRunId: capturedFullRunId }).catch((err: unknown) =>
              logger.error({ err, runId: capturedFullRunId }, "Dashboard trigger: Google export failed"),
            );
            await runMetaExport({ syncRunId: capturedFullRunId }).catch((err: unknown) =>
              logger.error({ err, runId: capturedFullRunId }, "Dashboard trigger: Meta export failed"),
            );
          }).catch((err: unknown) =>
            logger.error({ err, runId }, "Dashboard trigger: feed export lock not acquired"),
          );
          await fetchAndStoreDiagnostics().catch((err: unknown) =>
            logger.error({ err, runId }, "Dashboard trigger: Google diagnostics reconciliation failed"),
          );
        } else if (runType === "inventory") {
          const { runInventorySync } = await import("../../shopify/index");
          runId = await runInventorySync();
        } else if (runType === "prices") {
          const { runPriceSync } = await import("../../shopify/index");
          runId = await runPriceSync();
        } else if (runType === "recommendations") {
          const { runRecommendationsSync } = await import("../../jobs/sync-recommendations");
          runId = await runRecommendationsSync();
        } else if (runType === "export") {
          const { runGoogleExport } = await import("../../exporters/google/runner");
          const { runMetaExport } = await import("../../exporters/meta/generator");
          const { SyncRunTracker } = await import("../../shopify/sync-run-tracker");
          const tracker = new SyncRunTracker();
          runId = await tracker.start("export", { trigger: "dashboard" });
          try {
            await runGoogleExport({ syncRunId: runId });
          } catch (err: unknown) {
            await tracker.logError({
              errorType: "export_failed",
              entityType: "channel",
              entityId: "google",
              message: err instanceof Error ? err.message : String(err),
            });
            logger.error({ err, runId }, "Dashboard trigger: Google export failed");
          }
          try {
            await runMetaExport({ syncRunId: runId });
          } catch (err: unknown) {
            await tracker.logError({
              errorType: "export_failed",
              entityType: "channel",
              entityId: "meta",
              message: err instanceof Error ? err.message : String(err),
            });
            logger.error({ err, runId }, "Dashboard trigger: Meta export failed");
          }
          await tracker.complete();
        }

        logger.info({ job: job.jobName, runId }, "Dashboard trigger: job completed");
      } catch (err: unknown) {
        logger.error({ err, runType, job: job.jobName }, "Dashboard trigger: job failed");
      } finally {
        releaseLock(job.jobName);
        // Post-run alert check — same as runJobWithLock's finally block.
        // Runs for all triggered syncs, success or failure. Fire-and-forget.
        const capturedRunId = runId;
        import("../../observability/alerts")
          .then(({ checkAlerts }) => checkAlerts(capturedRunId))
          .catch((alertErr: unknown) =>
            logger.error({ err: alertErr, runId: capturedRunId }, "Dashboard trigger: post-run alert check failed"),
          );
      }
    };
    runBackground().catch((err: unknown) =>
      logger.error({ err, runType }, "Dashboard trigger: unexpected error in background runner"),
    );
  });
});

export default router;
