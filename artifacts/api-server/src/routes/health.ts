import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const payload = HealthCheckResponse.parse({ status: "ok" });

/**
 * GET /api/health
 * Primary health check endpoint — required by spec §8.
 */
router.get("/health", (_req, res) => {
  res.json(payload);
});

/**
 * GET /api/healthz
 * Kubernetes-style alias for backwards compatibility.
 */
router.get("/healthz", (_req, res) => {
  res.json(payload);
});

export default router;
