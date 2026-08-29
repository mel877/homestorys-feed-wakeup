import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { requireInternalAuth } from "../middlewares/internal-auth";
import {
  DURABLE_FEED_PLAN_CONFIRMATION,
  planDurableFeedRun,
} from "../jobs/durable-feed-planner";

const PlanBody = z.object({
  confirmation: z.literal(DURABLE_FEED_PLAN_CONFIRMATION),
}).strict();

const router: IRouter = Router();
router.use(requireInternalAuth);

router.post("/feed-plan", async (req, res) => {
  const parsed = PlanBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: "error",
      error: `Planning requires confirmation "${DURABLE_FEED_PLAN_CONFIRMATION}"`,
    });
    return;
  }

  try {
    const result = await planDurableFeedRun(parsed.data);
    res.status(result.status === "conflict" ? 409 : 201).json(result);
  } catch (error) {
    req.log?.error?.({ err: error }, "Durable feed planning failed");
    res.status(503).json({
      status: "transient_error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;