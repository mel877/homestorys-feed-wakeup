import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { requireInternalAuth } from "../middlewares/internal-auth";
import { advanceNightlyCycle } from "../jobs/nightly-cycle";

const Body = z.object({
  cycleKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

function currentUtcCycleKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const router: IRouter = Router();
router.use(requireInternalAuth);

router.post("/nightly-cycle", async (req, res) => {
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: "failed",
      phase: "shopify",
      error: "Invalid nightly cycle options",
      details: parsed.error.issues,
    });
    return;
  }
  try {
    const result = await advanceNightlyCycle({
      cycleKey: parsed.data.cycleKey ?? currentUtcCycleKey(),
    });
    // A structured failure is a final answer, not a transient server error:
    // the workflow retries 5xx responses, so a 500 here looped until the
    // watchdog instead of stopping on the reported failure.
    res.status(200).json(result);
  } catch (error) {
    req.log?.error?.({ err: error }, "Nightly durable cycle failed");
    res.status(503).json({
      status: "failed",
      phase: "shopify",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;