import {
  db,
  pool,
  feedExportStepsTable,
  syncRunsTable,
  type FeedExportStep,
  type InsertFeedExportStep,
} from "@workspace/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  claimStep,
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

    const [active] = await tx
      .select({ id: feedExportStepsTable.id })
      .from(feedExportStepsTable)
      .where(inArray(feedExportStepsTable.status, ["pending", "running"]))
      .limit(1);
    if (active) {
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
 * Claims exactly one eligible step with row locking. Two Autoscale instances
 * cannot receive the same step, and expired leases are reclaimed naturally.
 */
export async function claimNextFeedExportStep(
  workerId: string,
  options: { leaseMs?: number; now?: Date } = {},
): Promise<FeedExportStepResult | null> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? new Date();
  const claimed = await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      WITH candidate AS (
        SELECT id
        FROM feed_export_steps AS candidate_step
        WHERE
          candidate_step.stage IN ('build', 'finalize')
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