import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { requireInternalAuth } from "../middlewares/internal-auth";
import {
  MAX_PUMP_BUDGET_MS,
  MAX_PUMP_STEPS,
  runDurableFeedPump,
} from "../jobs/durable-feed-pump";

const PumpBody = z.object({
  budgetMs: z.number().int().min(1_000).max(MAX_PUMP_BUDGET_MS).optional(),
  maxSteps: z.number().int().min(1).max(MAX_PUMP_STEPS).optional(),
}).strict();

const router: IRouter = Router();
router.use(requireInternalAuth);

router.post("/feed-pump", async (req, res) => {
  const parsed = PumpBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: "error",
      error: "Invalid pump options",
      details: parsed.error.issues,
    });
    return;
  }

  try {
    const result = await runDurableFeedPump(parsed.data);
    const statusCode = result.status === "conflict"
      ? 409
      : result.status === "transient_error"
        ? 503
        : result.status === "error"
          ? 500
          : 200;
    res.status(statusCode).json(result);
  } catch (error) {
    req.log?.error?.({ err: error }, "Durable feed pump failed");
    res.status(503).json({
      status: "transient_error",
      processed: 0,
      reclaimed: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;