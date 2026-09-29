import {
  db,
  pool,
  feedExportStepsTable,
  syncRunsTable,
  type FeedExportStep,
  type InsertFeedExportStep,
} from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  completeStep,
  failStep,
  type FeedExportStepState,
} from "./feed-export-step-state";

export interface FeedExportStepSpec {
  syncRunId: string;
  channel: "google" | "meta";
  stage: "build" | "publish" | "finalize";
  marketCode?: string;
  language?: string;
  batchIndex: number;
  cursor?: Record<string, unknown> | null;
  checkpoint?: Record<string, unknown> | null;
}

export interface FeedExportStepResult {
  step: FeedExportStep;
  reclaimed: boolean;
}

const DEFAULT_LEASE_MS = 4 * 60 * 1_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const EXPECTED_META_FINALIZER_REQUEUE_COUNT = 2;

export class FeedFinalizerRequeueCardinalityError extends Error {
  constructor(public readonly matched: number) {
    super(
      `Expected exactly ${EXPECTED_META_FINALIZER_REQUEUE_COUNT} blocked Meta finalizer steps, found ${matched}`,
    );
    this.name = "FeedFinalizerRequeueCardinalityError";
  }
}

export interface RequeuedMetaFinalizers {
  count: number;
  targets: Array<{
    id: string;
    marketCode: string;
    language: string;
    batchIndex: number;
  }>;
}

export class DurableFeedRunAbandonError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "DurableFeedRunAbandonError";
  }
}

export interface AbandonedDurableFeedRun {
  syncRunId: string;
  abandonedSteps: number;
}

export async function abandonDurableFeedRun(
  syncRunId: string,
): Promise<AbandonedDurableFeedRun> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext('durable-feed-plan'))
    `);

    const runResult = await tx.execute(sql`
      SELECT
        id,
        run_type,
        status,
        metadata->>'architecture' AS architecture
      FROM sync_runs
      WHERE id = ${syncRunId}::uuid
      FOR UPDATE
    `);
    const run = runResult.rows[0] as {
      id: string;
      run_type: string;
      status: string;
      architecture: string | null;
    } | undefined;

    if (!run) {
      throw new DurableFeedRunAbandonError("Durable feed run was not found", 404);
    }
    if (run.run_type !== "export") {
      throw new DurableFeedRunAbandonError(
        "Only export runs can be abandoned as durable feed runs",
        409,
      );
    }
    if (run.architecture !== "durable-feed") {
      throw new DurableFeedRunAbandonError(
        "Run is not a durable feed run",
        409,
      );
    }
    if (run.status !== "failed") {
      throw new DurableFeedRunAbandonError(
        "Durable feed run must already be failed before abandonment",
        409,
      );
    }

    const activeStepsResult = await tx.execute(sql`
      SELECT id, status
      FROM feed_export_steps
      WHERE sync_run_id = ${syncRunId}::uuid
        AND status IN ('pending', 'running')
      FOR UPDATE
    `);
    const activeSteps = activeStepsResult.rows as Array<{
      id: string;
      status: string;
    }>;
    if (activeSteps.some((step) => step.status === "running")) {
      throw new DurableFeedRunAbandonError(
        "Durable feed run has running steps and cannot be abandoned",
        409,
      );
    }

    const abandoned = await tx.execute(sql`
      UPDATE feed_export_steps
      SET
        status = 'failed',
        available_at = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = 'abandoned: obsolete pre-Task #101 run',
        updated_at = NOW()
      WHERE sync_run_id = ${syncRunId}::uuid
        AND status = 'pending'
      RETURNING id
    `);

    return {
      syncRunId,
      abandonedSteps: abandoned.rows.length,
    };
  });
}

function toState(step: FeedExportStep): FeedExportStepState {
  return {
    status: step.status as FeedExportStepState["status"],
    attempts: step.attempts,
    availableAt: step.availableAt,
    leaseExpiresAt: step.leaseExpiresAt,
    leaseOwner: step.leaseOwner,
    completedAt: step.completedAt,
    lastError: step.lastError,
  };
}

function mapStepRow(row: Record<string, unknown>): FeedExportStep {
  return {
    id: String(row.id),
    syncRunId: String(row.sync_run_id),
    channel: String(row.channel),
    stage: String(row.stage),
    marketCode: String(row.market_code),
    language: String(row.language),
    batchIndex: Number(row.batch_index),
    cursor: (row.cursor as Record<string, unknown> | null) ?? null,
    checkpoint: (row.checkpoint as Record<string, unknown> | null) ?? null,
    status: String(row.status),
    attempts: Number(row.attempts),
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leaseExpiresAt: (row.lease_expires_at as Date | null) ?? null,
    availableAt: (row.available_at as Date | null) ?? null,
    startedAt: (row.started_at as Date | null) ?? null,
    completedAt: (row.completed_at as Date | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    itemCount: (row.item_count as number | null) ?? null,
    artifactPath: (row.artifact_path as string | null) ?? null,
    sha256: (row.sha256 as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  } as FeedExportStep;
}

export async function ensureFeedExportSteps(
  specs: FeedExportStepSpec[],
): Promise<void> {
  if (specs.length === 0) return;
  const values: InsertFeedExportStep[] = specs.map((spec) => ({
    syncRunId: spec.syncRunId,
    channel: spec.channel,
    stage: spec.stage,
    marketCode: spec.marketCode ?? "",
    language: spec.language ?? "",
    batchIndex: spec.batchIndex,
    cursor: spec.cursor ?? null,
    checkpoint: spec.checkpoint ?? null,
    status: "pending",
    attempts: 0,
    availableAt: new Date(),
  }));
  await db
    .insert(feedExportStepsTable)
    .values(values)
    .onConflictDoNothing({
      target: [
        feedExportStepsTable.syncRunId,
        feedExportStepsTable.channel,
        feedExportStepsTable.stage,
        feedExportStepsTable.marketCode,
        feedExportStepsTable.language,
        feedExportStepsTable.batchIndex,
      ],
    });
}

export async function requeueBlockedMetaFinalizers(
  syncRunId: string,
): Promise<RequeuedMetaFinalizers> {
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE feed_export_steps
      SET
        status = 'pending',
        available_at = NOW(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        started_at = NULL,
        completed_at = NULL,
        last_error = NULL,
        item_count = NULL,
        artifact_path = NULL,
        sha256 = NULL,
        updated_at = NOW()
      WHERE sync_run_id = ${syncRunId}::uuid
        AND channel = 'meta'
        AND stage = 'finalize'
        AND status = 'completed'
        AND checkpoint->>'result' = 'blocked'
        AND checkpoint->>'published' = 'false'
        AND checkpoint->>'fileKey' IN ('meta-language-fr', 'meta-language-de')
      RETURNING id, market_code, language, batch_index
    `);
    const rows = result.rows as Array<{
      id: string;
      market_code: string;
      language: string;
      batch_index: number;
    }>;

    if (rows.length !== EXPECTED_META_FINALIZER_REQUEUE_COUNT) {
      throw new FeedFinalizerRequeueCardinalityError(rows.length);
    }

    return {
      count: rows.length,
      targets: rows.map((row) => ({
        id: String(row.id),
        marketCode: String(row.market_code),
        language: String(row.language),
        batchIndex: Number(row.batch_index),
      })),
    };
  });
}

export interface DurableFeedRunPlanInput {
  runId: string;
  metadata: Record<string, unknown>;
  specs: FeedExportStepSpec[];
  sourceSyncRunId?: string;
}

export async function findDurableFeedPlanBySource(
  sourceSyncRunId: string,
): Promise<{ runId: string } | null> {
  const result = await db.execute(sql`
    SELECT id
    FROM sync_runs
    WHERE run_type = 'export'
      AND metadata->>'architecture' = 'durable-feed'
      AND metadata->>'sourceSyncRunId' = ${sourceSyncRunId}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = result.rows[0] as { id: string } | undefined;
  return row ? { runId: String(row.id) } : null;
}

export async function isValidatedShopifySourceRun(
  sourceSyncRunId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT id
    FROM sync_runs
    WHERE id = ${sourceSyncRunId}::uuid
      AND run_type = 'full'
      AND status = 'completed'
      AND metadata->>'architecture' = 'durable-shopify'
      AND metadata->>'shopifyGate' = 'passed'
    LIMIT 1
  `);
  return result.rows.length === 1;
}

export async function persistDurableFeedRunPlan(
  input: DurableFeedRunPlanInput,
): Promise<{
  status: "planned" | "existing" | "conflict";
  insertedSteps: number;
  existingRunId?: string;
}> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext('durable-feed-plan'))
    `);

    if (input.sourceSyncRunId) {
      const existing = await tx.execute(sql`
        SELECT id
        FROM sync_runs
        WHERE run_type = 'export'
          AND metadata->>'architecture' = 'durable-feed'
          AND metadata->>'sourceSyncRunId' = ${input.sourceSyncRunId}
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const row = existing.rows[0] as { id: string } | undefined;
      if (row) {
        return {
          status: "existing",
          insertedSteps: 0,
          existingRunId: String(row.id),
        };
      }
    }

    const active = await tx.execute(sql`
      SELECT step.id
      FROM feed_export_steps AS step
      INNER JOIN sync_runs AS run
        ON run.id = step.sync_run_id
      WHERE step.status IN ('pending', 'running')
        AND run.status = 'running'
      LIMIT 1
    `);
    if (active.rows.length > 0) {
      return { status: "conflict", insertedSteps: 0 };
    }

    await tx.insert(syncRunsTable).values({
      id: input.runId,
      runType: "export",
      status: "running",
      metadata: input.metadata,
    });

    if (input.specs.length > 0) {
      await tx.insert(feedExportStepsTable).values(input.specs.map((spec) => ({
        syncRunId: spec.syncRunId,
        channel: spec.channel,
        stage: spec.stage,
        marketCode: spec.marketCode ?? "",
        language: spec.language ?? "",
        batchIndex: spec.batchIndex,
        cursor: spec.cursor ?? null,
        checkpoint: spec.checkpoint ?? null,
        status: "pending",
        attempts: 0,
        availableAt: new Date(),
      })));
    }
    return { status: "planned", insertedSteps: input.specs.length };
  });
}

/**
 * SQL condition (on alias candidate_step) matching a step a worker may claim.
 * Shared by the claim query and the deadlock detector so both agree.
 */
function claimableStepCondition(now: Date) {
  return sql`
          candidate_step.stage IN ('build', 'finalize')
          -- Never pump steps that belong to a failed, abandoned or completed run.
          AND EXISTS (
            SELECT 1
            FROM sync_runs AS candidate_run
            WHERE candidate_run.id = candidate_step.sync_run_id
              AND candidate_run.status = 'running'
          )
          AND (
            (
              candidate_step.status = 'pending'
              AND (
                candidate_step.available_at IS NULL
                OR candidate_step.available_at <= ${now}
              )
            )
            OR (
              candidate_step.status = 'running'
              AND candidate_step.lease_expires_at IS NOT NULL
              AND candidate_step.lease_expires_at <= ${now}
            )
          )
          AND (
            candidate_step.stage <> 'finalize'
            OR NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                candidate_step.checkpoint->'requiredBatchIndexes'
              ) AS required(batch_index)
              WHERE NOT EXISTS (
                SELECT 1
                FROM feed_export_steps AS build_step
                WHERE build_step.sync_run_id = candidate_step.sync_run_id
                  AND build_step.channel = candidate_step.channel
                  AND build_step.stage = 'build'
                  AND build_step.market_code = candidate_step.market_code
                  AND build_step.language = candidate_step.language
                  AND build_step.batch_index = required.batch_index::integer
                  AND build_step.checkpoint->>'fileKey'
                    = candidate_step.checkpoint->>'fileKey'
                  AND build_step.status = 'completed'
              )
            )
          )
          AND (
            candidate_step.stage <> 'finalize'
            OR NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                COALESCE(
                  candidate_step.checkpoint->'requiredFinalizerFileKeys',
                  '[]'::jsonb
                )
              ) AS required(file_key)
              WHERE NOT EXISTS (
                SELECT 1
                FROM feed_export_steps AS dependency_step
                WHERE dependency_step.sync_run_id = candidate_step.sync_run_id
                  AND dependency_step.channel = candidate_step.channel
                  AND dependency_step.stage = 'finalize'
                  AND dependency_step.checkpoint->>'fileKey' = required.file_key
                  AND dependency_step.status = 'completed'
                  AND dependency_step.checkpoint->>'published' = 'true'
              )
            )
          )
  `;
}

/**
 * Claims exactly one eligible step with row locking. Two Autoscale instances
 * cannot receive the same step, and expired leases are reclaimed naturally.
 */
export interface ClaimFeedExportStepOptions {
  leaseMs?: number;
  now?: Date;
  /** false: only build steps (parallel lanes must not assemble whole files). */
  allowFinalize?: boolean;
}

export async function claimNextFeedExportStep(
  workerId: string,
  options: ClaimFeedExportStepOptions = {},
): Promise<FeedExportStepResult | null> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? new Date();
  const allowFinalize = options.allowFinalize ?? true;
  const claimed = await db.transaction(async (tx) => {
    // Serialize claims so the "one finalizer at a time" rule below also holds
    // across overlapping requests. Claims are short, the lock is per tx.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('feed-export-step-claim'))`);
    const result = await tx.execute(sql`
      WITH candidate AS (
        SELECT id
        FROM feed_export_steps AS candidate_step
        WHERE ${claimableStepCondition(now)}
          AND (
            candidate_step.stage <> 'finalize'
            OR (
              ${allowFinalize}
              -- A finalizer assembles and validates a whole feed file in
              -- memory: running several at once exhausted the instance.
              AND NOT EXISTS (
                SELECT 1
                FROM feed_export_steps AS busy_step
                WHERE busy_step.stage = 'finalize'
                  AND busy_step.status = 'running'
                  AND busy_step.lease_expires_at > ${now}
              )
            )
          )
        ORDER BY candidate_step.updated_at ASC, candidate_step.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE feed_export_steps AS step
      SET
        status = 'running',
        attempts = step.attempts + 1,
        lease_owner = ${workerId},
        lease_expires_at = ${new Date(now.getTime() + leaseMs)},
        available_at = NULL,
        started_at = COALESCE(step.started_at, ${now}),
        last_error = NULL,
        updated_at = ${now}
      FROM candidate
      WHERE step.id = candidate.id
      RETURNING step.*
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapStepRow(row) : null;
  });

  return claimed
    ? { step: claimed, reclaimed: claimed.attempts > 1 }
    : null;
}

export async function renewFeedExportStepLease(
  stepId: string,
  workerId: string,
  options: { leaseMs?: number; now?: Date } = {},
): Promise<boolean> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? new Date();
  const rows = await db
    .update(feedExportStepsTable)
    .set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(and(
      eq(feedExportStepsTable.id, stepId),
      eq(feedExportStepsTable.status, "running"),
      eq(feedExportStepsTable.leaseOwner, workerId),
    ))
    .returning({ id: feedExportStepsTable.id });
  return rows.length === 1;
}

export async function completeFeedExportStep(
  stepId: string,
  workerId: string,
  output: {
    checkpoint?: Record<string, unknown> | null;
    itemCount?: number | null;
    artifactPath?: string | null;
    sha256?: string | null;
  } = {},
): Promise<boolean> {
  const [current] = await db
    .select()
    .from(feedExportStepsTable)
    .where(eq(feedExportStepsTable.id, stepId))
    .limit(1);
  if (!current) return false;
  completeStep(toState(current), workerId, new Date());
  const rows = await db
    .update(feedExportStepsTable)
    .set({
      status: "completed",
      checkpoint: output.checkpoint ?? current.checkpoint,
      itemCount: output.itemCount ?? current.itemCount,
      artifactPath: output.artifactPath ?? current.artifactPath,
      sha256: output.sha256 ?? current.sha256,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(feedExportStepsTable.id, stepId),
      eq(feedExportStepsTable.status, "running"),
      eq(feedExportStepsTable.leaseOwner, workerId),
    ))
    .returning({ id: feedExportStepsTable.id });
  return rows.length === 1;
}

export async function failFeedExportStep(
  stepId: string,
  workerId: string,
  error: unknown,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<"retry" | "failed" | "conflict"> {
  const [current] = await db
    .select()
    .from(feedExportStepsTable)
    .where(eq(feedExportStepsTable.id, stepId))
    .limit(1);
  if (!current) return "conflict";
  const next = failStep(
    toState(current),
    workerId,
    new Date(),
    error instanceof Error ? error.message : String(error),
    maxAttempts,
  );
  const rows = await db
    .update(feedExportStepsTable)
    .set({
      status: next.status,
      availableAt: next.availableAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: null,
      lastError: next.lastError,
      updatedAt: new Date(),
    })
    .where(and(
      eq(feedExportStepsTable.id, stepId),
      eq(feedExportStepsTable.status, "running"),
      eq(feedExportStepsTable.leaseOwner, workerId),
    ))
    .returning({ id: feedExportStepsTable.id });
  if (rows.length !== 1) return "conflict";
  return next.status === "failed" ? "failed" : "retry";
}

export async function deferFeedExportStep(
  stepId: string,
  workerId: string,
  delayMs = 1_000,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(feedExportStepsTable)
    .set({
      status: "pending",
      attempts: sql`GREATEST(${feedExportStepsTable.attempts} - 1, 0)`,
      availableAt: new Date(now.getTime() + delayMs),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(and(
      eq(feedExportStepsTable.id, stepId),
      eq(feedExportStepsTable.status, "running"),
      eq(feedExportStepsTable.leaseOwner, workerId),
    ))
    .returning({ id: feedExportStepsTable.id });
  return rows.length === 1;
}

export async function releaseExpiredFeedExportLeases(): Promise<number> {
  const rows = await db
    .update(feedExportStepsTable)
    .set({
      status: "pending",
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: new Date(),
      updatedAt: new Date(),
    })
    .where(sql`
      ${feedExportStepsTable.status} = 'running'
      AND ${feedExportStepsTable.leaseExpiresAt} IS NOT NULL
      AND ${feedExportStepsTable.leaseExpiresAt} <= NOW()
    `)
    .returning({ id: feedExportStepsTable.id });
  return rows.length;
}

export async function getFeedExportStepSummary(syncRunId: string): Promise<{
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}> {
  const rows = await db
    .select({
      status: feedExportStepsTable.status,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(feedExportStepsTable)
    .where(eq(feedExportStepsTable.syncRunId, syncRunId))
    .groupBy(feedExportStepsTable.status);
  const summary = { total: 0, pending: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    const status = row.status as keyof typeof summary;
    if (status in summary && status !== "total") summary[status] = row.count;
    summary.total += row.count;
  }
  return summary;
}

export async function listFeedExportBuildStepsForFile(input: {
  syncRunId: string;
  channel: "google" | "meta";
  marketCode: string;
  language: string;
  fileKey: string;
}): Promise<FeedExportStep[]> {
  const rows = await db
    .select()
    .from(feedExportStepsTable)
    .where(and(
      eq(feedExportStepsTable.syncRunId, input.syncRunId),
      eq(feedExportStepsTable.channel, input.channel),
      eq(feedExportStepsTable.stage, "build"),
      eq(feedExportStepsTable.marketCode, input.marketCode),
      eq(feedExportStepsTable.language, input.language),
    ))
    .orderBy(asc(feedExportStepsTable.batchIndex));
  return rows.filter((row) => {
    const checkpoint = row.checkpoint as { fileKey?: unknown } | null;
    return checkpoint?.fileKey === input.fileKey;
  });
}

export async function getFeedExportStepById(
  stepId: string,
): Promise<FeedExportStep | null> {
  const [step] = await db
    .select()
    .from(feedExportStepsTable)
    .where(eq(feedExportStepsTable.id, stepId))
    .limit(1);
  return step ?? null;
}

export async function withFeedFinalizationLock<T>(
  lockKey: string,
  callback: () => Promise<T>,
): Promise<T | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [lockKey],
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) return null;
    return await callback();
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    }
    client.release();
  }
}
export async function completeFeedExportRun(syncRunId: string): Promise<void> {
  await db
    .update(syncRunsTable)
    .set({
      status: "completed",
      finishedAt: new Date(),
      durationMs: sql<number>`EXTRACT(EPOCH FROM (NOW() - ${syncRunsTable.startedAt})) * 1000`,
    })
    .where(and(
      eq(syncRunsTable.id, syncRunId),
      eq(syncRunsTable.status, "running"),
    ));
}

export async function failFeedExportRun(
  syncRunId: string,
  reason: string,
): Promise<void> {
  await db
    .update(syncRunsTable)
    .set({
      status: "failed",
      finishedAt: new Date(),
      durationMs: sql<number>`EXTRACT(EPOCH FROM (NOW() - ${syncRunsTable.startedAt})) * 1000`,
      metadata: sql`COALESCE(${syncRunsTable.metadata}, '{}'::jsonb) || ${JSON.stringify({
        failureReason: reason,
      })}::jsonb`,
    })
    .where(and(
      eq(syncRunsTable.id, syncRunId),
      eq(syncRunsTable.status, "running"),
    ));
}

/**
 * Returns the running durable feed run that blocks a new plan, if any.
 */
export async function findActiveDurableFeedRun(): Promise<{ runId: string } | null> {
  const result = await db.execute(sql`
    SELECT run.id
    FROM sync_runs AS run
    WHERE run.run_type = 'export'
      AND run.status = 'running'
      AND EXISTS (
        SELECT 1
        FROM feed_export_steps AS step
        WHERE step.sync_run_id = run.id
          AND step.status IN ('pending', 'running')
      )
    ORDER BY run.created_at ASC
    LIMIT 1
  `);
  const row = result.rows[0] as { id: string } | undefined;
  return row ? { runId: String(row.id) } : null;
}

export interface SettledDurableFeedRun {
  /** Finalizers closed because a required component was not published. */
  skipped: number;
  /** Steps a worker could claim right now. */
  claimable: number;
  /** Pending steps waiting for a retry backoff (not a deadlock). */
  waitingRetry: number;
  /** Running steps whose lease is still held by a live worker. */
  leased: number;
  /**
   * Sample of pending steps when nothing is claimable, waiting or leased:
   * they can never run (deadlock).
   */
  stuckSteps: Array<{ id: string; stage: string; fileKey: string | null }>;
}

/**
 * Resolves finalizers that can never run and detects deadlocked steps.
 *
 * A Meta market finalizer requires its base/language/country finalizers to be
 * completed AND published. When a component is blocked by the validation or
 * snapshot gate (completed, published=false) or has failed, the dependent
 * finalizer used to stay pending forever: the run never completed, stayed
 * "running", and every following nightly plan was rejected as a conflict.
 */
export async function settleDurableFeedRun(
  syncRunId: string,
): Promise<SettledDurableFeedRun> {
  let skipped = 0;
  for (let pass = 0; pass < 5; pass++) {
    const result = await db.execute(sql`
      UPDATE feed_export_steps AS step
      SET
        status = 'completed',
        checkpoint = COALESCE(step.checkpoint, '{}'::jsonb) || jsonb_build_object(
          'result', 'skipped',
          'published', false,
          'skippedReason', 'required component feed was not published'
        ),
        lease_owner = NULL,
        lease_expires_at = NULL,
        available_at = NULL,
        completed_at = NOW(),
        last_error = 'skipped: required component feed was not published',
        updated_at = NOW()
      WHERE step.sync_run_id = ${syncRunId}::uuid
        AND step.stage = 'finalize'
        AND step.status = 'pending'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(step.checkpoint->'requiredFinalizerFileKeys', '[]'::jsonb)
          ) AS required(file_key)
          WHERE EXISTS (
            SELECT 1
            FROM feed_export_steps AS dependency_step
            WHERE dependency_step.sync_run_id = step.sync_run_id
              AND dependency_step.channel = step.channel
              AND dependency_step.stage = 'finalize'
              AND dependency_step.checkpoint->>'fileKey' = required.file_key
              AND (
                dependency_step.status = 'failed'
                OR (
                  dependency_step.status = 'completed'
                  AND COALESCE(dependency_step.checkpoint->>'published', 'false') <> 'true'
                )
              )
          )
        )
      RETURNING step.id
    `);
    if (result.rows.length === 0) break;
    skipped += result.rows.length;
  }

  const now = new Date();
  const stateResult = await db.execute(sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM feed_export_steps AS candidate_step
        WHERE candidate_step.sync_run_id = ${syncRunId}::uuid
          AND ${claimableStepCondition(now)}
      ) AS claimable,
      (
        SELECT COUNT(*)::int
        FROM feed_export_steps AS step
        WHERE step.sync_run_id = ${syncRunId}::uuid
          AND step.status = 'pending'
          AND step.available_at IS NOT NULL
          AND step.available_at > ${now}
      ) AS waiting_retry,
      (
        SELECT COUNT(*)::int
        FROM feed_export_steps AS step
        WHERE step.sync_run_id = ${syncRunId}::uuid
          AND step.status = 'running'
          AND step.lease_expires_at IS NOT NULL
          AND step.lease_expires_at > ${now}
      ) AS leased
  `);
  const state = stateResult.rows[0] as {
    claimable: number;
    waiting_retry: number;
    leased: number;
  } | undefined;
  const claimable = Number(state?.claimable ?? 0);
  const waitingRetry = Number(state?.waiting_retry ?? 0);
  const leased = Number(state?.leased ?? 0);

  let stuckSteps: SettledDurableFeedRun["stuckSteps"] = [];
  if (claimable === 0 && waitingRetry === 0 && leased === 0) {
    const pendingResult = await db.execute(sql`
      SELECT id, stage, checkpoint->>'fileKey' AS file_key
      FROM feed_export_steps
      WHERE sync_run_id = ${syncRunId}::uuid
        AND status = 'pending'
      ORDER BY stage, checkpoint->>'fileKey', batch_index
      LIMIT 20
    `);
    stuckSteps = (pendingResult.rows as Array<{
      id: string;
      stage: string;
      file_key: string | null;
    }>).map((row) => ({
      id: String(row.id),
      stage: String(row.stage),
      fileKey: row.file_key,
    }));
  }
  return { skipped, claimable, waitingRetry, leased, stuckSteps };
}

export async function listUnpublishedFeedFiles(
  syncRunId: string,
): Promise<Array<{ fileKey: string; result: string }>> {
  const result = await db.execute(sql`
    SELECT
      checkpoint->>'fileKey' AS file_key,
      COALESCE(checkpoint->>'result', status) AS result
    FROM feed_export_steps
    WHERE sync_run_id = ${syncRunId}::uuid
      AND stage = 'finalize'
      AND (
        status = 'failed'
        OR (status = 'completed' AND COALESCE(checkpoint->>'published', 'false') <> 'true')
      )
    ORDER BY checkpoint->>'fileKey'
  `);
  return (result.rows as Array<{ file_key: string | null; result: string }>).map((row) => ({
    fileKey: String(row.file_key ?? "unknown"),
    result: String(row.result),
  }));
}
