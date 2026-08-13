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
import { requireInternalAuth } from "../middlewares/internal-auth";
import { db } from "@workspace/db";
import { syncRunsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  runFullSync,
  runInventorySync,
  runPriceSync,
  syncProduct,
} from "../shopify/index";

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

// ── Sync trigger routes ────────────────────────────────────────────────────────

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
        const { runGoogleExport } = await import("../exporters/google/runner");
        const { runMetaExport } = await import("../exporters/meta/generator");
        const { fetchAndStoreDiagnostics } = await import("../exporters/google/diagnostics");
        const runId = await runFullSync();
        await runGoogleExport({ syncRunId: runId }).catch((err) =>
          logger.error({ err }, "Google re-export failed after full sync"),
        );
        await runMetaExport({ syncRunId: runId }).catch((err) =>
          logger.error({ err }, "Meta re-export failed after full sync"),
        );
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

export default router;
