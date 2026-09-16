/**
 * In-process cron scheduler for the feed engine.
 *
 * Runs inside the Reserved VM worker process. Each job has a schedule
 * expressed as { hour, minute } for time-of-day jobs or { intervalMs }
 * for periodic jobs.
 *
 * Concurrency safety:
 *   The in-process `runningJobs` Set is the primary guard. Because Node.js is
 *   single-threaded, the Set check + add is an atomic operation — no two event
 *   loop ticks can interleave it. A secondary DB check covers the restart case
 *   (process crashed while a job was running, leaving a stale "running" row).
 *
 *   `runJobWithLock` is exported so the internal API routes use the same guard,
 *   preventing API-triggered and scheduled runs from overlapping.
 *
 * Post-run alerting:
 *   After every sync job (success or failure), `checkAlerts` runs automatically
 *   to evaluate the six alert conditions (spec §43) and log/post any new alerts.
 *
 * Spec references: §5 (scheduling), §43 (alerting), §60 (observability).
 */

import { db, syncRunsTable } from "@workspace/db";
import { eq, and, gt, sql } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";
import { loadConfig } from "../config/loader";
import type { SyncRunType } from "../shopify/sync-run-tracker";

const logger = rootLogger.child({ module: "scheduler" });

// ── Types ─────────────────────────────────────────────────────────────────────

interface JobDefinition {
  /** Unique name for this job — used in log messages and DB checks. */
  name: string;
  /** The sync run type stored in sync_runs. */
  runType: SyncRunType;
  /** Schedule: either a fixed time-of-day or a periodic interval. */
  schedule:
    | { kind: "daily"; hour: number; minute: number }
    | { kind: "interval"; intervalMs: number };
  /** Whether to skip if Shopify env vars are not configured. */
  requiresShopify?: boolean;
  /** The async function to execute. Must return a run ID string. */
  run: () => Promise<string>;
}

// Max age for a "running" record to be considered live (not orphaned).
const MAX_STALE_MS = 2 * 60 * 60 * 1_000; // 2 hours

// ── Cron → schedule converter ─────────────────────────────────────────────────

type JobSchedule = JobDefinition["schedule"];

/**
 * Convert a simplified cron expression to a JobSchedule.
 *
 * Supports two patterns (UTC):
 *   "0 H * * *"    → { kind: "daily",    hour: H, minute: 0 }
 *   "0 *\/N * * *" → { kind: "interval", intervalMs: N * 3600_000 }
 *
 * These cover all cron strings in feed-policy.yaml.
 * Throws for any unsupported format so mis-configuration is caught at startup.
 */
export function parseCronToSchedule(cron: string): JobSchedule {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Unsupported cron format (expected 5 fields): "${cron}"`);
  }
  const [minuteField, hourField, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*" || dow !== "*") {
    throw new Error(`Unsupported cron format (only * supported for DOM/month/DOW): "${cron}"`);
  }

  // "0 * * * *"  → every 1 hour  (same as */1)
  // "0 */N * * *" → every N hours
  if (minuteField === "0" && (hourField === "*" || hourField?.startsWith("*/"))) {
    const n = hourField === "*" ? 1 : parseInt(hourField.slice(2), 10);
    if (isNaN(n) || n < 1) throw new Error(`Invalid hour interval in cron: "${cron}"`);
    return { kind: "interval", intervalMs: n * 60 * 60 * 1_000 };
  }

  // "M H * * *" → daily at H:M
  const m = parseInt(minuteField ?? "", 10);
  const h = parseInt(hourField ?? "", 10);
  if (!isNaN(m) && !isNaN(h)) {
    return { kind: "daily", hour: h, minute: m };
  }

  throw new Error(`Unsupported cron format: "${cron}"`);
}

// ── In-process lock ───────────────────────────────────────────────────────────

/**
 * Primary concurrency guard. Node.js is single-threaded, so a Set check+add
 * is an atomic operation — no two scheduled or API-triggered syncs can acquire
 * the same lock simultaneously.
 */
const runningJobs = new Set<string>();

// ── DB staleness check (covers process restart) ───────────────────────────────

/**
 * Secondary concurrency guard. Checks for a live "running" DB row as a safety
 * net for when the process restarted mid-job and the in-memory Set was lost.
 */
async function isRunningInDb(runType: SyncRunType): Promise<boolean> {
  const cutoff = new Date(Date.now() - MAX_STALE_MS);
  const rows = await db
    .select({ id: syncRunsTable.id })
    .from(syncRunsTable)
    .where(
      and(
        eq(syncRunsTable.runType, runType),
        eq(syncRunsTable.status, "running"),
        gt(syncRunsTable.startedAt, cutoff),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ── Lock acquire / release ─────────────────────────────────────────────────────

type LockResult = { acquired: true } | { acquired: false; reason: string };

export async function tryAcquireLock(jobName: string, runType: SyncRunType): Promise<LockResult> {
  // Synchronous check + claim before any await.
  // Because Node.js is single-threaded, no other code can run between these
  // two lines. A concurrent caller will see the Set entry on its next tick.
  if (runningJobs.has(jobName)) {
    return { acquired: false, reason: "in-process lock held" };
  }
  runningJobs.add(jobName); // ← claimed BEFORE the first await

  // Secondary DB check (covers process-restart orphaned rows).
  // If it finds a live row, release the in-process lock we just claimed.
  try {
    const dbRunning = await isRunningInDb(runType);
    if (dbRunning) {
      runningJobs.delete(jobName);
      return { acquired: false, reason: "DB running row exists (< 2h old)" };
    }
  } catch {
    // DB unavailable — in-process lock is still held; proceed
  }

  return { acquired: true };
}

export function releaseLock(jobName: string): void {
  runningJobs.delete(jobName);
}

// ── Shared job runner (exported for API routes) ────────────────────────────────

/**
 * Run a sync function under the scheduler's concurrency lock.
 *
 * Exported so that internal API-triggered syncs use the same guard as
 * scheduled runs, preventing overlap between the two trigger paths.
 *
 * @param jobName  Unique key for the in-process lock (matches JobDefinition.name)
 * @param runType  DB run type for the secondary staleness check
 * @param fn       Async function to execute; must return a run ID string
 * @returns        The run ID on success, or null if the lock was not acquired
 */
export async function runJobWithLock(
  jobName: string,
  runType: SyncRunType,
  fn: () => Promise<string>,
): Promise<string | null> {
  const lock = await tryAcquireLock(jobName, runType);
  if (!lock.acquired) {
    logger.info({ job: jobName, reason: lock.reason }, "Scheduler: skipping — lock not acquired");
    return null;
  }

  logger.info({ job: jobName }, "Scheduler: job starting");
  let runId: string | null = null;

  try {
    runId = await fn();
    logger.info({ job: jobName, runId }, "Scheduler: job completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ job: jobName, err: message }, "Scheduler: job failed");
  } finally {
    releaseLock(jobName);

    // Post-run alert check — always fires for an acquired job, success OR failure.
    // Pass the run ID when the job started (even partial runs log a sync_runs row).
    // Fire-and-forget: failures are logged, not re-thrown.
    const capturedRunId = runId;
    import("../observability/alerts")
      .then(({ checkAlerts }) => checkAlerts(capturedRunId))
      .catch((alertErr) =>
        logger.error({ err: alertErr, runId: capturedRunId }, "Post-run alert check failed"),
      );
  }

  return runId;
}

// ── Time utilities ────────────────────────────────────────────────────────────

/** Returns wall-clock ms until the next occurrence of a daily UTC schedule. */
export function msUntilNext(hour: number, minute: number, now = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

// ── Scheduler lifecycle ────────────────────────────────────────────────────────

const intervalTimers: ReturnType<typeof setInterval>[] = [];
const timeoutTimers: ReturnType<typeof setTimeout>[] = [];
let started = false;

/**
 * Start the scheduler.
 * Imports jobs lazily (dynamic import) so the scheduler module can be loaded
 * without pulling in all Shopify/exporter dependencies at startup.
 */
export async function startScheduler(): Promise<void> {
  if (started) {
    logger.warn("Scheduler already started — ignoring duplicate start");
    return;
  }
  started = true;

  // Reap orphaned runs: any sync_run still "running" at process start was
  // killed by a restart/crash and can never finish — mark it failed so the
  // dashboard and lock logic never see a ghost "running" run.
  try {
    const reaped = await db
      .update(syncRunsTable)
      .set({
        status: "failed",
        finishedAt: new Date(),
        metadata: sql`COALESCE(${syncRunsTable.metadata}, '{}'::jsonb) || '{"failureReason":"orphaned: process restarted while run was in progress"}'::jsonb`,
      })
      .where(and(
        eq(syncRunsTable.status, "running"),
        sql`COALESCE(${syncRunsTable.metadata}->>'architecture', '') NOT IN ('durable-shopify', 'durable-feed')`,
      ))
      .returning({ id: syncRunsTable.id });
    if (reaped.length > 0) {
      logger.warn(
        { runIds: reaped.map((r) => r.id) },
        "Scheduler: reaped orphaned running sync runs from previous process",
      );
    }
  } catch (err) {
    logger.error({ err }, "Scheduler: failed to reap orphaned sync runs");
  }

  // Load configuration — schedules are derived from feedPolicy.sync_schedule
  // (cron expressions in UTC) so ops can adjust cadence via config without code changes.
  let scheduleConfig: {
    full: string;
    prices: string;
    inventory: string;
    recommendations: string;
    google: string;
  };
  try {
    scheduleConfig = loadConfig().feedPolicy.sync_schedule;
    logger.info({ scheduleConfig }, "Scheduler: loaded schedule from feed-policy.yaml");
  } catch (err) {
    // Config unavailable in test/cold-start — fall back to spec defaults
    logger.warn({ err }, "Scheduler: could not load feed policy config, using spec defaults");
    scheduleConfig = {
      full: "0 2 * * *",
      prices: "0 */2 * * *",
      inventory: "0 * * * *",
      recommendations: "0 3 * * *",
      google: "30 3 * * *",
    };
  }

  // The durable nightly workflow is the only scheduled Shopify batch writer.
  // Manual Shopify routes and real-time webhooks remain available.
  const { runRecommendationsSync } = await import("./sync-recommendations");

  const jobs: JobDefinition[] = [
    {
      name: "recommendations-sync",
      runType: "recommendations",
      schedule: parseCronToSchedule(scheduleConfig.recommendations),
      requiresShopify: false,
      run: async () => runRecommendationsSync(),
    },
  ];

  function scheduleJob(job: JobDefinition): void {
    if (job.requiresShopify && (!process.env["SHOPIFY_CLIENT_ID"] || !process.env["SHOPIFY_CLIENT_SECRET"])) {
      logger.debug({ job: job.name }, "Scheduler: Shopify not configured — skipping job");
      return;
    }

    const tick = () =>
      runJobWithLock(job.name, job.runType, job.run).catch((err) =>
        logger.error({ job: job.name, err }, "Scheduler: unhandled error in runJobWithLock"),
      );

    if (job.schedule.kind === "interval") {
      const timer = setInterval(tick, job.schedule.intervalMs);
      intervalTimers.push(timer);
      logger.info(
        { job: job.name, intervalMs: job.schedule.intervalMs },
        "Scheduler: interval job registered",
      );
    } else {
      const { hour, minute } = job.schedule;
      const firstFireMs = msUntilNext(hour, minute);
      const firstFireAt = new Date(Date.now() + firstFireMs).toISOString();

      const timer = setTimeout(() => {
        tick();
        const repeat = setInterval(tick, 24 * 60 * 60 * 1_000);
        intervalTimers.push(repeat);
      }, firstFireMs);
      timeoutTimers.push(timer);

      logger.info(
        { job: job.name, hour, minute, firstFireAt },
        "Scheduler: daily job registered",
      );
    }
  }

  for (const job of jobs) scheduleJob(job);
  logger.info({ jobCount: jobs.length }, "Scheduler: started");
}

/**
 * Gracefully stop the scheduler (for tests and clean shutdown).
 */
export function stopScheduler(): void {
  for (const t of intervalTimers) clearInterval(t);
  for (const t of timeoutTimers) clearTimeout(t);
  intervalTimers.length = 0;
  timeoutTimers.length = 0;
  runningJobs.clear();
  started = false;
  logger.info("Scheduler: stopped");
}

export function isSchedulerStarted(): boolean {
  return started;
}
