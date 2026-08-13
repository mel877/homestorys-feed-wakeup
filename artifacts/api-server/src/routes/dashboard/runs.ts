import { Router, type IRouter } from "express";
import { db, syncRunsTable, syncErrorsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { ListSyncRunsQueryParams, GetSyncRunParams, TriggerSyncBody } from "@workspace/api-zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";

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

  // Use the internal sync route — call the job directly
  try {
    let runId: string;

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
    } else {
      res.status(400).json({ error: `Unknown runType: ${runType as string}` });
      return;
    }

    res.json({ runId, runType, status: "started" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("lock") || message.includes("running")) {
      res.status(409).json({ error: "A sync of this type is already running" });
    } else {
      logger.error({ err }, "Failed to trigger sync");
      res.status(500).json({ error: "Failed to trigger sync" });
    }
  }
});

export default router;
