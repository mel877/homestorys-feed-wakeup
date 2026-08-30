import { Router, type IRouter } from "express";
import { db, syncRunsTable, syncErrorsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { ListSyncRunsQueryParams, GetSyncRunParams, TriggerSyncBody } from "@workspace/api-zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { tryAcquireLock, releaseLock } from "../../jobs/scheduler";
import type { SyncRunTracker as SyncRunTrackerType, SyncRunType } from "../../shopify/sync-run-tracker";

/** Map dashboard runType to scheduler job name and SyncRunType. */
const JOB_MAP: Record<string, { jobName: string; runType: SyncRunType }> = {
  full: { jobName: "full-sync", runType: "full" },
  inventory: { jobName: "inventory-sync", runType: "inventory" },
  prices: { jobName: "price-sync", runType: "prices" },
  recommendations: { jobName: "recommendations-sync", runType: "recommendations" },
  // Feed export only (Google + Meta) — regenerates channel feeds from the
  // already-synced canonical data without re-running the full Shopify sync.
  export: { jobName: "feed-export", runType: "export" },
  // Showroom-only export — Eupen store availability feed for Google + Meta.
  showroom: { jobName: "showroom-export", runType: "showroom" },
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
      metadata: r.metadata ?? null,
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
      metadata: run.metadata ?? null,
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

  if (runType === "export") {
    let runId: string | null = null;
    let tracker: SyncRunTrackerType | null = null;
    let finalResponse: {
      statusCode: number;
      body: Record<string, unknown>;
    };

    try {
      logger.info({ job: job.jobName }, "Dashboard trigger: job starting");
      const { runGoogleExport } = await import("../../exporters/google/runner");
      const { runMetaExportInFreshProcess } = await import("../../exporters/meta/fresh-process");
      const { SyncRunTracker } = await import("../../shopify/sync-run-tracker");
      tracker = new SyncRunTracker();
      runId = await tracker.start("export", { trigger: "dashboard" });

      let googleResult: unknown = null;
      const channelErrors: Record<string, string> = {};

      try {
        googleResult = await runGoogleExport({ syncRunId: runId });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        channelErrors.google = message;
        await tracker.logError({
          errorType: "export_failed",
          entityType: "channel",
          entityId: "google",
          message,
        });
        logger.error({ err, runId }, "Dashboard trigger: Google export failed");
      }

      try {
        await runMetaExportInFreshProcess({ syncRunId: runId });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        channelErrors.meta = message;
        await tracker.logError({
          errorType: "export_failed",
          entityType: "channel",
          entityId: "meta",
          message,
        });
        logger.error({ err, runId }, "Dashboard trigger: Meta export failed");
      }

      const result = {
        google: googleResult,
        meta: { completed: !channelErrors.meta },
      };
      const errorMessages = Object.entries(channelErrors)
        .map(([channel, message]) => `${channel}: ${message}`)
        .join("; ");

      if (errorMessages) {
        await tracker.fail(new Error(errorMessages));
        finalResponse = {
          statusCode: 500,
          body: {
            runType,
            status: "failed",
            runId,
            error: errorMessages,
            errors: channelErrors,
            result,
          },
        };
      } else {
        await tracker.complete();
        finalResponse = {
          statusCode: 200,
          body: {
            runType,
            status: "completed",
            runId,
            result,
          },
        };
      }
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      if (tracker && runId) {
        try {
          await tracker.fail(err);
        } catch (trackerError: unknown) {
          logger.error(
            { err: trackerError, runId },
            "Dashboard trigger: failed to mark export run as failed",
          );
        }
      }
      logger.error({ err, runType, job: job.jobName, runId }, "Dashboard trigger: export failed");
      finalResponse = {
        statusCode: 500,
        body: {
          runType,
          status: "failed",
          runId,
          error: cause,
        },
      };
    } finally {
      releaseLock(job.jobName);
      const capturedRunId = runId;
      try {
        const { checkAlerts } = await import("../../observability/alerts");
        await checkAlerts(capturedRunId);
      } catch (alertErr: unknown) {
        logger.error(
          { err: alertErr, runId: capturedRunId },
          "Dashboard trigger: post-run alert check failed",
        );
      }
    }

    res.status(finalResponse.statusCode).json(finalResponse.body);
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
          runId = await runFullSync();
        } else if (runType === "inventory") {
          const { runInventorySync } = await import("../../shopify/index");
          runId = await runInventorySync();
        } else if (runType === "prices") {
          const { runPriceSync } = await import("../../shopify/index");
          runId = await runPriceSync();
        } else if (runType === "recommendations") {
          const { runRecommendationsSync } = await import("../../jobs/sync-recommendations");
          runId = await runRecommendationsSync();
        } else if (runType === "showroom") {
          const { runShowroomExport } = await import("../../exporters/showroom/runner");
          const { SyncRunTracker } = await import("../../shopify/sync-run-tracker");
          const tracker = new SyncRunTracker();
          runId = await tracker.start("showroom", { trigger: "dashboard" });
          try {
            await runShowroomExport({ syncRunId: runId });
          } catch (err: unknown) {
            await tracker.logError({
              errorType: "export_failed",
              entityType: "channel",
              entityId: "showroom",
              message: err instanceof Error ? err.message : String(err),
            });
            logger.error({ err, runId }, "Dashboard trigger: Showroom export failed");
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
