import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { requireInternalAuth } from "../middlewares/internal-auth";
import {
  clearPendingShopifyContentionBackoff,
  requeueFailedShopifyStep,
  ShopifyStepRequeueError,
} from "../jobs/shopify-sync-step-repository";

const ShopifyStepRequeueBody = z.object({
  sourceSyncRunId: z.uuid(),
  step: z.literal("inventory"),
}).strict();

const router: IRouter = Router();
router.use(requireInternalAuth);

router.post("/shopify/clear-contention-backoff", async (req, res): Promise<void> => {
  const parsed = ShopifyStepRequeueBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: "error",
      error: "Invalid Shopify contention backoff request",
      details: parsed.error.issues,
    });
    return;
  }

  try {
    const result = await clearPendingShopifyContentionBackoff(parsed.data);
    res.status(200).json({
      status: "backoff-cleared",
      sourceSyncRunId: result.sourceSyncRunId,
      step: result.step,
      stepId: result.stepId,
      stepStatus: result.status,
      attempts: result.attempts,
    });
  } catch (error) {
    if (error instanceof ShopifyStepRequeueError) {
      res.status(error.statusCode).json({
        status: "error",
        error: error.message,
      });
      return;
    }

    req.log?.error?.({ err: error }, "Shopify contention backoff clear failed");
    res.status(500).json({
      status: "error",
      error: "Shopify contention backoff clear failed",
    });
  }
});

router.post("/shopify/requeue-step", async (req, res): Promise<void> => {
  const parsed = ShopifyStepRequeueBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: "error",
      error: "Invalid Shopify step requeue request",
      details: parsed.error.issues,
    });
    return;
  }

  try {
    const result = await requeueFailedShopifyStep(parsed.data);
    res.status(200).json({
      status: "requeued",
      sourceSyncRunId: result.sourceSyncRunId,
      step: result.step,
      stepId: result.stepId,
      stepStatus: result.status,
      attempts: result.attempts,
    });
  } catch (error) {
    if (error instanceof ShopifyStepRequeueError) {
      res.status(error.statusCode).json({
        status: "error",
        error: error.message,
      });
      return;
    }

    req.log?.error?.({ err: error }, "Shopify step requeue failed");
    res.status(500).json({
      status: "error",
      error: "Shopify step requeue failed",
    });
  }
});

export default router;