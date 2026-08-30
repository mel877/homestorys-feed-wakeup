/**
 * Internal API routes — authentication required (INTERNAL_API_SECRET).
 *
 * All POST /api/internal/sync/* routes go through `runJobWithLock` from the
 * scheduler. This ensures API-triggered and scheduled syncs share the same
 * in-process concurrency guard — they cannot overlap each other.
 *
 * `runJobWithLock` also fires `checkAlerts(runId)` automatically after each
 * sync completion or failure, so alerts are logged and posted to the webhook
 * regardless of whether the sync was triggered by the scheduler or the API.
 */

import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { requireInternalAuth } from "../middlewares/internal-auth";
import { db } from "@workspace/db";
import { syncRunsTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  runInventorySync,
  runPriceSync,
  syncProduct,
} from "../shopify/index";
import { tryAcquireLock, releaseLock } from "../jobs/scheduler";
import { SyncRunTracker } from "../shopify/sync-run-tracker";
import { SwissPriceValidationError } from "../shopify/swiss-price-repair";
import { tryAcquireMarketPriceWriteLock } from "../shopify/market-price-write-lock";
import feedPumpRouter from "./feed-pump";
import feedPlanRouter from "./feed-plan";
import feedFinalizersRouter from "./feed-finalizers";

const SWISS_PRICE_REPAIR_JOB_NAME = "swiss-price-repair";
const SWISS_PRICE_REPAIR_OPERATION = "repair:swiss-prices";
const SWISS_PRICE_REPAIR_CONFIRMATION = "APPLY_SWISS_PRICE_REPAIR";

const SwissPriceRepairBody = z.object({
  /**
   * Preview is the safe default. Applying requires the exact confirmation
   * phrase below; this keeps a copied request from becoming a write request.
   */
  apply: z.boolean().default(false),
  confirmation: z.string().optional(),
}).strict().superRefine((body, ctx) => {
  if (body.apply && body.confirmation !== SWISS_PRICE_REPAIR_CONFIRMATION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confirmation"],
      message: `Applying requires confirmation "${SWISS_PRICE_REPAIR_CONFIRMATION}"`,
    });
  }
  if (!body.apply && body.confirmation !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confirmation"],
      message: "Confirmation is only accepted when apply is true",
    });
  }
});

function isProductionEnvironment(): boolean {
  return process.env["APP_ENV"] === "production";
}

async function mergeSwissRepairMetadata(
  runId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .update(syncRunsTable)
    .set({
      metadata: sql`COALESCE(${syncRunsTable.metadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
    })
    .where(sql`${syncRunsTable.id} = ${runId}`);
}

// Lazy imports to avoid loading heavy modules at startup
async function getRunRecommendationsSync(): Promise<() => Promise<string>> {
  const m = await import("../jobs/sync-recommendations");
  return m.runRecommendationsSync;
}

async function getRunJobWithLock(): Promise<typeof import("../jobs/scheduler").runJobWithLock> {
  const m = await import("../jobs/scheduler");
  return m.runJobWithLock;
}

async function getCheckAlerts(): Promise<typeof import("../observability/alerts").checkAlerts> {
  const m = await import("../observability/alerts");
  return m.checkAlerts;
}

const router: IRouter = Router();

// All internal routes require INTERNAL_API_SECRET
router.use(requireInternalAuth);
router.use(feedPumpRouter);
router.use(feedPlanRouter);
router.use(feedFinalizersRouter);

// ── Sync trigger routes ────────────────────────────────────────────────────────

/**
 * POST /api/internal/repair/swiss-prices
 *
 * Production-only, targeted repair trigger. This route intentionally does not
 * accept a run type or a job name: it can only invoke repair:swiss-prices.
 *
 * The default request is a read-only preview. Database writes additionally
 * require `apply: true` and the exact confirmation phrase. The full report is
 * stored in sync_runs.metadata and is available from the internal run list and
 * the dashboard run detail endpoint.
 */
router.post("/repair/swiss-prices", async (req, res): Promise<void> => {
  if (!isProductionEnvironment()) {
    res.status(403).json({ error: "Swiss price repair is available only in production" });
    return;
  }

  const parsed = SwissPriceRepairBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { apply } = parsed.data;
  const lock = await tryAcquireLock(
    SWISS_PRICE_REPAIR_JOB_NAME,
    "swiss-price-repair",
  );
  if (!lock.acquired) {
    res.status(409).json({ error: "A Swiss price repair is already running" });
    return;
  }

  let marketPriceLease;
  try {
    marketPriceLease = await tryAcquireMarketPriceWriteLock();
  } catch (error) {
    releaseLock(SWISS_PRICE_REPAIR_JOB_NAME);
    req.log.error({ err: error }, "Failed to acquire Swiss price repair database lock");
    res.status(503).json({ error: "Could not acquire Swiss price repair database lock" });
    return;
  }
  if (!marketPriceLease) {
    releaseLock(SWISS_PRICE_REPAIR_JOB_NAME);
    res.status(409).json({ error: "A market price writer is already running" });
    return;
  }

  const tracker = new SyncRunTracker();
  let runId: string;
  try {
    runId = await tracker.start("swiss-price-repair", {
      operation: SWISS_PRICE_REPAIR_OPERATION,
      trigger: "internal-api",
      mode: apply ? "apply" : "preview",
      authorization: apply ? "explicit-confirmation" : "read-only",
    });
  } catch (error) {
    let releaseError: unknown;
    try {
      await marketPriceLease.release();
    } catch (caughtReleaseError) {
      releaseError = caughtReleaseError;
      req.log.error(
        { err: caughtReleaseError },
        "Failed to release Swiss price repair database lock after run creation failure",
      );
    } finally {
      releaseLock(SWISS_PRICE_REPAIR_JOB_NAME);
    }
    req.log.error({ err: error }, "Failed to create Swiss price repair run");
    res.status(500).json({
      error: releaseError
        ? "Could not create Swiss price repair run; PostgreSQL lock release also failed"
        : "Could not create Swiss price repair run",
    });
    return;
  }

  const mode = apply ? "apply" : "preview";
  let finalResponse: {
    statusCode: number;
    body: Record<string, unknown>;
  };
  try {
    const { loadConfig } = await import("../config");
    const { getShopifyClient } = await import("../shopify/client");
    const { runSwissPriceRepair } = await import("../shopify/swiss-price-repair");
    const report = await runSwissPriceRepair({
      config: loadConfig(),
      client: getShopifyClient(),
      apply,
    });

    await mergeSwissRepairMetadata(runId, {
      report,
      reportStatus: "completed",
    });
    await tracker.complete();
    logger.info(
      { runId, mode, targetedVariants: report.targetedVariants },
      "Swiss price repair completed",
    );
    finalResponse = {
      statusCode: 200,
      body: {
        operation: SWISS_PRICE_REPAIR_OPERATION,
        mode,
        status: "completed",
        runId,
        report,
      },
    };
  } catch (error) {
    // Validation errors are persisted in full, including every issue, so a
    // failed apply can be audited without rerunning Shopify or the repair.
    const validation = error instanceof SwissPriceValidationError
      ? {
          status: "aborted-before-write",
          issueCount: error.issues.length,
          issues: error.issues,
          noCurrencyConversionPerformed: true,
        }
      : undefined;
    try {
      await tracker.fail(error);
      await mergeSwissRepairMetadata(runId, {
        ...(validation ? { validation } : {}),
        reportStatus: validation ? "validation-failed" : "failed",
      });
    } catch (recordingError) {
      req.log.error(
        { err: recordingError, runId },
        "Failed to persist Swiss price repair failure report",
      );
    }
    req.log.error({ err: error, runId }, "Swiss price repair failed");
    finalResponse = {
      statusCode: 500,
      body: {
        operation: SWISS_PRICE_REPAIR_OPERATION,
        mode,
        status: "failed",
        runId,
        error: error instanceof Error ? error.message : String(error),
        ...(validation ? { validation } : {}),
      },
    };
  } finally {
    try {
      await marketPriceLease.release();
    } catch (releaseError) {
      req.log.error(
        { err: releaseError, runId },
        "Failed to release Swiss price repair database lock",
      );
      finalResponse = {
        statusCode: 500,
        body: {
          operation: SWISS_PRICE_REPAIR_OPERATION,
          mode,
          status: "failed",
          runId,
          error: "Swiss price repair finished but PostgreSQL lock release failed",
        },
      };
    } finally {
      releaseLock(SWISS_PRICE_REPAIR_JOB_NAME);
    }
  }
  res.status(finalResponse.statusCode).json(finalResponse.body);
});

/**
 * POST /api/internal/sync/full
 * Trigger a full catalog sync through the scheduler lock.
 * checkAlerts fires automatically after completion via runJobWithLock.
 */
router.post("/sync/full", (req, res) => {
  req.log.info("Full sync triggered via internal API");

  getRunJobWithLock()
    .then((withLock) =>
      withLock("full-sync", "full", async () => {
        const { runFullSyncPipeline } = await import("../jobs/full-sync-pipeline");
        const { fetchAndStoreDiagnostics } = await import("../exporters/google/diagnostics");
        const { runId } = await runFullSyncPipeline();
        // Reconcile Merchant Center diagnostics after Google export
        // (identical to the scheduler path — all trigger paths must behave the same)
        await fetchAndStoreDiagnostics().catch((err) =>
          logger.error({ err }, "Google diagnostics reconciliation failed after full sync"),
        );
        return runId;
      }),
    )
    .then((runId) =>
      logger.info({ runId }, runId ? "Full sync completed" : "Full sync skipped (lock held)"),
    )
    .catch((err) => logger.error({ err }, "Full sync failed"));

  res.json({ status: "started", type: "full", message: "Full sync started in background" });
});

/**
 * POST /api/internal/sync/inventory
 * Trigger an inventory-only sync through the scheduler lock.
 */
router.post("/sync/inventory", (req, res) => {
  req.log.info("Inventory sync triggered via internal API");

  getRunJobWithLock()
    .then((withLock) =>
      withLock("inventory-sync", "inventory", async () => runInventorySync()),
    )
    .then((runId) =>
      logger.info(
        { runId },
        runId ? "Inventory sync completed" : "Inventory sync skipped (lock held)",
      ),
    )
    .catch((err) => logger.error({ err }, "Inventory sync failed"));

  res.json({ status: "started", type: "inventory", message: "Inventory sync started in background" });
});

/**
 * POST /api/internal/sync/prices
 * Trigger a price-only sync through the scheduler lock.
 */
router.post("/sync/prices", (req, res) => {
  req.log.info("Price sync triggered via internal API");

  getRunJobWithLock()
    .then((withLock) =>
      withLock("price-sync", "prices", async () => runPriceSync()),
    )
    .then((runId) =>
      logger.info(
        { runId },
        runId ? "Price sync completed" : "Price sync skipped (lock held)",
      ),
    )
    .catch((err) => logger.error({ err }, "Price sync failed"));

  res.json({ status: "started", type: "prices", message: "Price sync started in background" });
});

/**
 * POST /api/internal/sync/recommendations
 * Trigger a recommendations recalculation through the scheduler lock.
 */
router.post("/sync/recommendations", (req, res) => {
  req.log.info("Recommendations sync triggered via internal API");

  Promise.all([getRunJobWithLock(), getRunRecommendationsSync()])
    .then(([withLock, runRecommendationsSync]) =>
      withLock("recommendations-sync", "recommendations", async () =>
        runRecommendationsSync(),
      ),
    )
    .then((runId) =>
      logger.info(
        { runId },
        runId ? "Recommendations sync completed" : "Recommendations sync skipped (lock held)",
      ),
    )
    .catch((err) => logger.error({ err }, "Recommendations sync failed"));

  res.json({
    status: "started",
    type: "recommendations",
    message: "Recommendations sync started in background",
  });
});

/**
 * POST /api/internal/alerts/check
 * Manually trigger an alert check and return current active alerts.
 */
router.post("/alerts/check", async (req, res) => {
  try {
    const checkAlerts = await getCheckAlerts();
    const alerts = await checkAlerts(null);
    res.json({ alerts, checkedAt: new Date().toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to check alerts");
    res.status(500).json({ error: "Alert check failed" });
  }
});

/**
 * POST /api/internal/classify
 * Trigger a standalone image classification drain without a full sync.
 * Useful to classify images that are already in the DB but were never
 * processed (e.g. after the first sync or when Phase 5 was interrupted).
 * Runs in background; responds immediately.
 */
router.post("/classify", (req, res) => {
  req.log.info("Standalone image classification triggered via internal API");

  import("../images/classify-stored")
    .then(({ classifyStoredImages }) => classifyStoredImages())
    .then((result) =>
      logger.info({ ...result }, "Standalone image classification complete"),
    )
    .catch((err) => logger.error({ err }, "Standalone image classification failed"));

  res.json({ status: "started", message: "Image classification started in background" });
});

/**
 * POST /api/internal/sync/product/:productRef
 * Trigger a targeted sync for a single product (by numeric ID or GID).
 * Single-product syncs do not go through the scheduler lock — they are
 * short-lived and are safe to run concurrently with bulk syncs.
 */
router.post("/sync/product/:productRef", (req, res) => {
  const { productRef } = req.params as { productRef: string };
  req.log.info({ productRef }, "Product sync triggered via internal API");

  syncProduct(productRef)
    .then((runId) => logger.info({ runId, productRef }, "Product sync completed"))
    .catch((err) => logger.error({ err, productRef }, "Product sync failed"));

  res.json({ status: "started", type: "product", productRef, message: "Product sync started in background" });
});

/**
 * GET /api/internal/runs
 * List recent sync runs.
 */
router.get("/runs", async (req, res) => {
  const limit = Math.min(parseInt((req.query["limit"] as string) ?? "50", 10), 200);

  try {
    const runs = await db
      .select()
      .from(syncRunsTable)
      .orderBy(desc(syncRunsTable.startedAt))
      .limit(limit);
    res.json({ runs });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch sync runs");
    res.status(500).json({ error: "Failed to fetch sync runs" });
  }
});

/**
 * GET /api/internal/runs/:runId
 * Fetch one complete run, including a persisted Swiss repair report.
 */
router.get("/runs/:runId", async (req, res) => {
  const rawRunId = Array.isArray(req.params["runId"])
    ? req.params["runId"][0]
    : req.params["runId"];
  const parsed = z.uuid().safeParse(rawRunId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }

  try {
    const [run] = await db
      .select()
      .from(syncRunsTable)
      .where(eq(syncRunsTable.id, parsed.data))
      .limit(1);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json({ run });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch sync run");
    res.status(500).json({ error: "Failed to fetch sync run" });
  }
});

export default router;
