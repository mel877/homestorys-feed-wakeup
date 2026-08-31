import {
  db,
  shopifySyncStepsTable,
  syncRunsTable,
  type ShopifySyncStep,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { failStep, type FeedExportStepState } from "./feed-export-step-state";

export const SHOPIFY_PHASES = [
  "products",
  "pricing",
  "inventory",
  "translations",
  "images",
  "completion",
] as const;
export type ShopifySyncPhase = typeof SHOPIFY_PHASES[number];

const DEFAULT_LEASE_MS = 15 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export class ShopifySyncLeaseLostError extends Error {
  constructor() {
    super("Shopify sync step lease was lost or expired");
    this.name = "ShopifySyncLeaseLostError";
  }
}

export class ShopifyStepRequeueError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409 = 409,
  ) {
    super(message);
    this.name = "ShopifyStepRequeueError";
  }
}

/** Commit one durable business unit and its resumable position as one database
 * transaction.  The lock and second conditional update protect against a worker
 * whose lease expired while it was performing the business write. */
export async function commitShopifySyncUnit(input: {
  stepId: string;
  workerId: string;
  cursor?: Record<string, unknown> | null;
  checkpoint?: Record<string, unknown> | null;
  writer: (tx: unknown) => Promise<void>;
  database?: Pick<typeof db, "transaction">;
}): Promise<void> {
  const database = input.database ?? db;
  await database.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id
      FROM shopify_sync_steps
      WHERE id = ${input.stepId}::uuid
        AND status = 'running'
        AND lease_owner = ${input.workerId}
        AND lease_expires_at > clock_timestamp()
      FOR UPDATE
    `);
    if (locked.rows.length !== 1) throw new ShopifySyncLeaseLostError();

    await input.writer(tx);

    // Recheck after the writer: a lease may expire during a slow SQL unit.
    const updated = await tx.execute(sql`
      UPDATE shopify_sync_steps
      SET cursor = ${input.cursor ?? null}::jsonb,
          checkpoint = ${input.checkpoint ?? null}::jsonb,
          updated_at = NOW()
      WHERE id = ${input.stepId}::uuid
        AND status = 'running'
        AND lease_owner = ${input.workerId}
        AND lease_expires_at > clock_timestamp()
      RETURNING id
    `);
    if (updated.rows.length !== 1) throw new ShopifySyncLeaseLostError();
  });
}

function mapRow(row: Record<string, unknown>): ShopifySyncStep {
  return {
    id: String(row.id),
    syncRunId: String(row.sync_run_id),
    phase: String(row.phase),
    sequence: Number(row.sequence),
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
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  } as ShopifySyncStep;
}

export async function ensureDurableShopifyRun(
  cycleKey: string,
): Promise<{ runId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('durable-shopify-cycle'))`);
    const existing = await tx.execute(sql`
      SELECT id
      FROM sync_runs
      WHERE run_type = 'full'
        AND metadata->>'architecture' = 'durable-shopify'
        AND metadata->>'nightlyCycleKey' = ${cycleKey}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = existing.rows[0] as { id: string } | undefined;
    if (row) return { runId: String(row.id), created: false };

    const [run] = await tx
      .insert(syncRunsTable)
      .values({
        runType: "full",
        status: "running",
        metadata: {
          architecture: "durable-shopify",
          trigger: "nightly",
          nightlyCycleKey: cycleKey,
        },
      })
      .returning({ id: syncRunsTable.id });
    const runId = run!.id;
    await tx.insert(shopifySyncStepsTable).values(
      SHOPIFY_PHASES.map((phase, sequence) => ({
        syncRunId: runId,
        phase,
        sequence,
        batchIndex: 0,
        status: "pending",
        attempts: 0,
        availableAt: new Date(),
      })),
    );
    return { runId, created: true };
  });
}

export async function claimNextShopifySyncStep(
  syncRunId: string,
  workerId: string,
  options: { leaseMs?: number; now?: Date } = {},
): Promise<{ step: ShopifySyncStep; reclaimed: boolean } | null> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const result = await db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      WITH candidate AS (
        SELECT candidate_step.id
        FROM shopify_sync_steps AS candidate_step
        WHERE candidate_step.sync_run_id = ${syncRunId}::uuid
          AND (
            (candidate_step.status = 'pending'
              AND (candidate_step.available_at IS NULL OR candidate_step.available_at <= ${now}))
            OR
            (candidate_step.status = 'running'
              AND candidate_step.lease_expires_at IS NOT NULL
              AND candidate_step.lease_expires_at <= ${now})
          )
          AND NOT EXISTS (
            SELECT 1
            FROM shopify_sync_steps AS prerequisite
            WHERE prerequisite.sync_run_id = candidate_step.sync_run_id
              AND prerequisite.sequence < candidate_step.sequence
              AND prerequisite.status <> 'completed'
          )
        ORDER BY candidate_step.sequence, candidate_step.batch_index
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE shopify_sync_steps AS step
      SET status = 'running',
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
    const row = claimed.rows[0] as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  });
  return result ? { step: result, reclaimed: result.attempts > 1 } : null;
}

export async function completeShopifySyncStep(
  stepId: string,
  workerId: string,
  output: { checkpoint?: Record<string, unknown> | null } = {},
): Promise<boolean> {
  const rows = await db
    .update(shopifySyncStepsTable)
    .set({
      status: "completed",
      checkpoint: output.checkpoint,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(shopifySyncStepsTable.id, stepId),
      eq(shopifySyncStepsTable.status, "running"),
      eq(shopifySyncStepsTable.leaseOwner, workerId),
      sql`${shopifySyncStepsTable.leaseExpiresAt} > NOW()`,
    ))
    .returning({ id: shopifySyncStepsTable.id });
  return rows.length === 1;
}

export async function renewShopifySyncStepLease(
  stepId: string,
  workerId: string,
  options: { leaseMs?: number; now?: Date } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const rows = await db
    .update(shopifySyncStepsTable)
    .set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(and(
      eq(shopifySyncStepsTable.id, stepId),
      eq(shopifySyncStepsTable.status, "running"),
      eq(shopifySyncStepsTable.leaseOwner, workerId),
      sql`${shopifySyncStepsTable.leaseExpiresAt} > ${now}`,
    ))
    .returning({ id: shopifySyncStepsTable.id });
  return rows.length === 1;
}

export async function saveShopifySyncStepProgress(
  stepId: string,
  workerId: string,
  output: {
    cursor?: Record<string, unknown> | null;
    checkpoint?: Record<string, unknown> | null;
  },
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(shopifySyncStepsTable)
    .set({
      status: "pending",
      cursor: output.cursor,
      checkpoint: output.checkpoint,
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(shopifySyncStepsTable.id, stepId),
      eq(shopifySyncStepsTable.status, "running"),
      eq(shopifySyncStepsTable.leaseOwner, workerId),
      sql`${shopifySyncStepsTable.leaseExpiresAt} > ${now}`,
    ))
    .returning({ id: shopifySyncStepsTable.id });
  return rows.length === 1;
}

export async function failShopifySyncStep(
  stepId: string,
  workerId: string,
  error: unknown,
  maxAttempts: number | null = DEFAULT_MAX_ATTEMPTS,
): Promise<"retry" | "failed" | "conflict"> {
  const [current] = await db
    .select()
    .from(shopifySyncStepsTable)
    .where(eq(shopifySyncStepsTable.id, stepId))
    .limit(1);
  if (!current || current.status !== "running" || current.leaseOwner !== workerId) {
    return "conflict";
  }
  const next = failStep(
    {
      status: current.status,
      attempts: current.attempts,
      availableAt: current.availableAt,
      leaseExpiresAt: current.leaseExpiresAt,
      leaseOwner: current.leaseOwner,
      completedAt: current.completedAt,
      lastError: current.lastError,
    } as FeedExportStepState,
    workerId,
    new Date(),
    error instanceof Error ? error.message : String(error),
    maxAttempts,
  );
  const rows = await db
    .update(shopifySyncStepsTable)
    .set({
      status: next.status,
      availableAt: next.availableAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: next.lastError,
      updatedAt: new Date(),
    })
    .where(and(
      eq(shopifySyncStepsTable.id, stepId),
      eq(shopifySyncStepsTable.status, "running"),
      eq(shopifySyncStepsTable.leaseOwner, workerId),
    ))
    .returning({ id: shopifySyncStepsTable.id });
  if (rows.length !== 1) return "conflict";
  return next.status === "failed" ? "failed" : "retry";
}

function isEmptyProgress(value: unknown): boolean {
  return value === null ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

export async function requeueFailedShopifyStep(input: {
  sourceSyncRunId: string;
  step: "inventory";
}): Promise<{
  sourceSyncRunId: string;
  step: "inventory";
  stepId: string;
  status: "pending";
  attempts: 0;
}> {
  return db.transaction(async (tx) => {
    const runResult = await tx.execute(sql`
      SELECT id
      FROM sync_runs
      WHERE id = ${input.sourceSyncRunId}::uuid
        AND run_type = 'full'
        AND metadata->>'architecture' = 'durable-shopify'
      FOR UPDATE
    `);
    if (runResult.rows.length !== 1) {
      throw new ShopifyStepRequeueError("Shopify sync run was not found", 404);
    }

    const stepResult = await tx.execute(sql`
      SELECT id, status, cursor, checkpoint
      FROM shopify_sync_steps
      WHERE sync_run_id = ${input.sourceSyncRunId}::uuid
        AND phase = 'inventory'
        AND batch_index = 0
      FOR UPDATE
    `);
    const step = stepResult.rows[0] as {
      id: string;
      status: string;
      cursor: unknown;
      checkpoint: unknown;
    } | undefined;
    if (!step) {
      throw new ShopifyStepRequeueError("Inventory step was not found", 404);
    }
    if (step.status === "completed") {
      throw new ShopifyStepRequeueError("Completed Shopify steps cannot be requeued");
    }
    if (step.status !== "failed") {
      throw new ShopifyStepRequeueError("Only failed Shopify steps can be requeued");
    }
    if (!isEmptyProgress(step.cursor) || !isEmptyProgress(step.checkpoint)) {
      throw new ShopifyStepRequeueError(
        "Only a failed inventory step with an empty checkpoint can be requeued",
      );
    }

    const prerequisites = await tx.execute(sql`
      SELECT phase, status
      FROM shopify_sync_steps
      WHERE sync_run_id = ${input.sourceSyncRunId}::uuid
        AND phase IN ('products', 'pricing')
      FOR UPDATE
    `);
    const completedPrerequisites = new Set(
      prerequisites.rows
        .filter((row) => String(row.status) === "completed")
        .map((row) => String(row.phase)),
    );
    if (!completedPrerequisites.has("products") || !completedPrerequisites.has("pricing")) {
      throw new ShopifyStepRequeueError(
        "Products and pricing must be completed before inventory can be requeued",
      );
    }

    const updated = await tx.execute(sql`
      UPDATE shopify_sync_steps
      SET status = 'pending',
          attempts = 0,
          available_at = NOW(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          completed_at = NULL,
          updated_at = NOW()
      WHERE id = ${step.id}::uuid
        AND sync_run_id = ${input.sourceSyncRunId}::uuid
        AND phase = 'inventory'
        AND status = 'failed'
      RETURNING id
    `);
    if (updated.rows.length !== 1) {
      throw new ShopifyStepRequeueError("Inventory step changed while it was being requeued");
    }

    return {
      sourceSyncRunId: input.sourceSyncRunId,
      step: "inventory",
      stepId: String(updated.rows[0]!.id),
      status: "pending",
      attempts: 0,
    };
  });
}

export async function releaseExpiredShopifySyncLeases(): Promise<number> {
  const rows = await db
    .update(shopifySyncStepsTable)
    .set({
      status: "pending",
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: new Date(),
      updatedAt: new Date(),
    })
    .where(sql`
      ${shopifySyncStepsTable.status} = 'running'
      AND ${shopifySyncStepsTable.leaseExpiresAt} IS NOT NULL
      AND ${shopifySyncStepsTable.leaseExpiresAt} <= NOW()
    `)
    .returning({ id: shopifySyncStepsTable.id });
  return rows.length;
}

export async function getShopifySyncStepSummary(syncRunId: string): Promise<{
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}> {
  const rows = await db
    .select({
      status: shopifySyncStepsTable.status,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(shopifySyncStepsTable)
    .where(eq(shopifySyncStepsTable.syncRunId, syncRunId))
    .groupBy(shopifySyncStepsTable.status);
  const summary = { total: 0, pending: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    const count = Number(row.count);
    summary.total += count;
    if (row.status in summary && row.status !== "total") {
      summary[row.status as "pending" | "running" | "completed" | "failed"] = count;
    }
  }
  return summary;
}

export async function validateShopifyCompletionGate(
  syncRunId: string,
): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const summary = await getShopifySyncStepSummary(syncRunId);
  if (summary.failed > 0) reasons.push("mandatory Shopify step failed");
  if (summary.total !== SHOPIFY_PHASES.length || summary.completed !== SHOPIFY_PHASES.length) {
    reasons.push("mandatory Shopify steps incomplete");
  }
  const freshness = await db.execute(sql`
    SELECT phase, completed_at
    FROM shopify_sync_steps
    WHERE sync_run_id = ${syncRunId}::uuid
      AND phase IN ('pricing', 'inventory')
      AND status = 'completed'
      AND completed_at >= (
        SELECT started_at FROM sync_runs WHERE id = ${syncRunId}::uuid
      )
  `);
  const freshPhases = new Set(freshness.rows.map((row) => String(row.phase)));
  if (!freshPhases.has("pricing")) reasons.push("pricing freshness not validated");
  if (!freshPhases.has("inventory")) reasons.push("inventory freshness not validated");
  return { ok: reasons.length === 0, reasons };
}

export async function completeDurableShopifyRun(syncRunId: string): Promise<void> {
  await db.update(syncRunsTable).set({
    status: "completed",
    finishedAt: new Date(),
    metadata: sql`COALESCE(${syncRunsTable.metadata}, '{}'::jsonb) || '{"shopifyGate":"passed","swissCurrencyGuard":true}'::jsonb`,
  }).where(eq(syncRunsTable.id, syncRunId));
}

export async function failDurableShopifyRun(
  syncRunId: string,
  reasons: string[],
): Promise<void> {
  await db.update(syncRunsTable).set({
    status: "failed",
    finishedAt: new Date(),
    metadata: sql`COALESCE(${syncRunsTable.metadata}, '{}'::jsonb) || ${JSON.stringify({
      failureReason: reasons.join("; "),
      shopifyGate: "failed",
    })}::jsonb`,
  }).where(eq(syncRunsTable.id, syncRunId));
}