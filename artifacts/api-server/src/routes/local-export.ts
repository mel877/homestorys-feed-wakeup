/**
 * Localhost-only export trigger routes.
 *
 * These routes are accessible ONLY from 127.0.0.1 (same-container curl).
 * They are intentionally NOT protected by INTERNAL_API_SECRET so they can
 * be called from CLI / ShellExec without a secret configured.
 *
 * Security: only loopback addresses are allowed — the routes are never
 * reachable from outside the container.
 *
 * Locking: every export runs inside withExportLock, the same shared lock
 * used by the scheduler, dashboard, and internal-sync paths. This prevents
 * concurrent publishes that would produce nondeterministic feed pointers
 * and feed_snapshots isCurrent rows.
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { logger as rootLogger } from "../lib/logger";

const logger = rootLogger.child({ module: "local-export" });

const router: IRouter = Router();

/**
 * Middleware: reject any request not coming from loopback.
 */
function requireLocalhost(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!isLocal) {
    res.status(403).json({ error: "Local access only" });
    return;
  }
  next();
}

router.use(requireLocalhost);

/**
 * POST /api/local/export/meta
 * Trigger the Meta feed export in the background.
 * Returns immediately; the export runs inside the shared feed-export lock
 * so it can never overlap a concurrently running publish from any other path.
 */
router.post("/export/meta", (req, res) => {
  logger.info("Local meta export triggered");

  Promise.all([
    import("../exporters/export-lock"),
    import("../exporters/meta/fresh-process"),
  ])
    .then(([{ withExportLock }, { runMetaExportInFreshProcess }]) =>
      withExportLock(() => runMetaExportInFreshProcess()),
    )
    .then(() => logger.info("Local meta export complete"))
    .catch((err) => logger.error({ err }, "Local meta export failed"));

  res.json({ status: "started", message: "Meta export running in background" });
});

/**
 * POST /api/local/export/google
 * Trigger the Google feed export in the background.
 * Runs inside the shared feed-export lock (same as Meta and scheduler paths).
 */
router.post("/export/google", (req, res) => {
  logger.info("Local google export triggered");

  Promise.all([
    import("../exporters/export-lock"),
    import("../exporters/google/runner"),
  ])
    .then(([{ withExportLock }, { runGoogleExport }]) =>
      withExportLock(() => runGoogleExport({})),
    )
    .then((result) =>
      logger.info(
        { totalCanonicals: result.totalCanonicals, durationMs: result.durationMs },
        "Local google export complete",
      ),
    )
    .catch((err) => logger.error({ err }, "Local google export failed"));

  res.json({ status: "started", message: "Google export running in background" });
});

export default router;
