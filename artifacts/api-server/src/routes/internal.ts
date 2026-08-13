import { Router, type IRouter } from "express";
import { requireInternalAuth } from "../middlewares/internal-auth";
import { db } from "@workspace/db";
import { syncRunsTable } from "@workspace/db";
import { desc } from "drizzle-orm";

const router: IRouter = Router();

// All internal routes require INTERNAL_API_SECRET
router.use(requireInternalAuth);

/**
 * POST /api/internal/sync/full
 * Trigger a full catalog sync (implemented in task #2+)
 */
router.post("/sync/full", async (req, res) => {
  req.log.info("Full sync triggered via internal API");
  // Stub: actual sync logic added in Sync Orchestration task
  res.json({ status: "queued", type: "full", message: "Sync engine not yet implemented" });
});

/**
 * POST /api/internal/sync/inventory
 * Trigger an inventory-only sync
 */
router.post("/sync/inventory", async (req, res) => {
  req.log.info("Inventory sync triggered via internal API");
  res.json({ status: "queued", type: "inventory", message: "Sync engine not yet implemented" });
});

/**
 * POST /api/internal/sync/prices
 * Trigger a price-only sync
 */
router.post("/sync/prices", async (req, res) => {
  req.log.info("Price sync triggered via internal API");
  res.json({ status: "queued", type: "prices", message: "Sync engine not yet implemented" });
});

/**
 * POST /api/internal/sync/product/:variantId
 * Trigger a targeted sync for a single variant
 */
router.post("/sync/product/:variantId", async (req, res) => {
  const { variantId } = req.params as { variantId: string };
  req.log.info({ variantId }, "Product sync triggered via internal API");
  res.json({ status: "queued", type: "product", variantId, message: "Sync engine not yet implemented" });
});

/**
 * GET /api/internal/runs
 * List recent sync runs
 */
router.get("/runs", async (req, res) => {
  try {
    const runs = await db
      .select()
      .from(syncRunsTable)
      .orderBy(desc(syncRunsTable.startedAt))
      .limit(50);
    res.json({ runs });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch sync runs");
    res.status(500).json({ error: "Failed to fetch sync runs" });
  }
});

export default router;
