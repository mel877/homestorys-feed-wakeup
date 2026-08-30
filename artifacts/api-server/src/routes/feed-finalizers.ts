import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { requireInternalAuth } from "../middlewares/internal-auth";
import {
  FeedFinalizerRequeueCardinalityError,
  requeueBlockedMetaFinalizers,
} from "../jobs/feed-export-step-repository";

const FeedFinalizersRequeueBody = z.object({
  syncRunId: z.uuid(),
}).strict();

const router: IRouter = Router();
router.use(requireInternalAuth);

router.post("/feed-finalizers/requeue", async (req, res): Promise<void> => {
  const parsed = FeedFinalizersRequeueBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: "error",
      error: "Invalid feed finalizers requeue request",
      details: parsed.error.issues,
    });
    return;
  }

  try {
    const result = await requeueBlockedMetaFinalizers(parsed.data.syncRunId);
    res.status(200).json({
      status: "requeued",
      ...result,
    });
  } catch (error) {
    if (error instanceof FeedFinalizerRequeueCardinalityError) {
      res.status(409).json({
        status: "error",
        error: error.message,
        matched: error.matched,
        expected: 2,
      });
      return;
    }

    req.log?.error?.({ err: error }, "Meta finalizer requeue failed");
    res.status(500).json({
      status: "error",
      error: "Meta finalizer requeue failed",
    });
  }
});

export default router;