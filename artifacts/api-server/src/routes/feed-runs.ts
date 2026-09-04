import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { requireInternalAuth } from "../middlewares/internal-auth";
import {
  abandonDurableFeedRun,
  DurableFeedRunAbandonError,
} from "../jobs/feed-export-step-repository";

export const DURABLE_FEED_RUN_ABANDON_CONFIRMATION =
  "ABANDON_DURABLE_FEED_RUN";

const AbandonBody = z.object({
  syncRunId: z.uuid(),
  confirmation: z.literal(DURABLE_FEED_RUN_ABANDON_CONFIRMATION),
}).strict();

const router: IRouter = Router();
router.use(requireInternalAuth);

router.post("/feed-runs/abandon", async (req, res): Promise<void> => {
  const parsed = AbandonBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: "error",
      error: `Abandonment requires confirmation "${DURABLE_FEED_RUN_ABANDON_CONFIRMATION}"`,
      details: parsed.error.issues,
    });
    return;
  }

  try {
    const result = await abandonDurableFeedRun(parsed.data.syncRunId);
    res.status(200).json({
      status: "abandoned",
      ...result,
    });
  } catch (error) {
    if (error instanceof DurableFeedRunAbandonError) {
      res.status(error.statusCode).json({
        status: "error",
        error: error.message,
      });
      return;
    }

    req.log?.error?.({ err: error }, "Durable feed run abandonment failed");
    res.status(500).json({
      status: "error",
      error: "Durable feed run abandonment failed",
    });
  }
});

export default router;