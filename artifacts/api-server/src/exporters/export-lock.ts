/**
 * Shared feed-export lock.
 *
 * All paths that publish Google/Meta feeds (standalone dashboard export,
 * post-full-sync export from the scheduler, internal API, or dashboard full
 * sync) MUST serialize behind this single lock. The exporters overwrite the
 * same "current" object-storage paths and toggle the same feed_snapshots
 * current rows, so concurrent publishes produce race-dependent output.
 *
 * The standalone export trigger acquires the lock up front (to return 409 to
 * the user); full-sync paths use waitForExportLock to wait until any
 * in-flight publish finishes rather than skipping the export.
 */
import { tryAcquireLock, releaseLock } from "../jobs/scheduler";
import { logger } from "../lib/logger";

export const EXPORT_LOCK_JOB_NAME = "feed-export";

const RETRY_INTERVAL_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Runs `fn` while holding the shared feed-export lock, waiting (polling) for
 * up to `maxWaitMs` if another publish is in progress. Throws if the lock
 * cannot be acquired within the wait budget.
 */
export async function withExportLock<T>(
  fn: () => Promise<T>,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const lock = await tryAcquireLock(EXPORT_LOCK_JOB_NAME, "export");
    if (lock.acquired) break;
    if (Date.now() + RETRY_INTERVAL_MS > deadline) {
      throw new Error(
        `Timed out waiting ${maxWaitMs}ms for the feed-export lock — another feed publish is still running`,
      );
    }
    logger.info("Feed export waiting for in-flight publish to finish");
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
  }
  try {
    return await fn();
  } finally {
    releaseLock(EXPORT_LOCK_JOB_NAME);
  }
}
