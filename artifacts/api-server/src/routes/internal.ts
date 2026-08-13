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

const router: IRouter = Router();

// All internal routes require INTERNAL_API_SECRET
router.use(requireInternalAuth);

/**
 * POST /api/internal/sync/full
 * Trigger a full catalog sync (runs async — returns runId immediately).
 */
router.post("/sync/full", (req, res) => {
  req.log.info("Full sync triggered via internal API");

  // Fire-and-forget: run in background, return run ID immediately
  runFullSync()
    .then((runId) => logger.info({ runId }, "Full sync completed"))
    .catch((err) => logger.error({ err }, "Full sync failed"));

  // Return queued status — client can poll /api/internal/runs for progress
  res.json({ status: "started", type: "full", message: "Full sync started in background" });
});

/**
 * POST /api/internal/sync/inventory
 * Trigger an inventory-only sync.
 */
router.post("/sync/inventory", (req, res) => {
  req.log.info("Inventory sync triggered via internal API");

  runInventorySync()
    .then((runId) => logger.info({ runId }, "Inventory sync completed"))
    .catch((err) => logger.error({ err }, "Inventory sync failed"));

  res.json({ status: "started", type: "inventory", message: "Inventory sync started in background" });
});

/**
 * POST /api/internal/sync/prices
 * Trigger a price-only sync.
 */
router.post("/sync/prices", (req, res) => {
  req.log.info("Price sync triggered via internal API");

  runPriceSync()
    .then((runId) => logger.info({ runId }, "Price sync completed"))
    .catch((err) => logger.error({ err }, "Price sync failed"));

  res.json({ status: "started", type: "prices", message: "Price sync started in background" });
});

/**
 * POST /api/internal/sync/product/:productRef
 * Trigger a targeted sync for a single product (by numeric ID or GID).
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
