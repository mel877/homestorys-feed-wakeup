/**
 * SyncRunTracker — manages a sync_runs row throughout its lifecycle.
 *
 * Creates a run at start, updates counters periodically, and marks the run
 * complete or failed at the end. Also inserts into sync_errors on failure.
 */

import { db, syncRunsTable, syncErrorsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";

const logger = rootLogger.child({ module: "sync-run-tracker" });

export interface SyncStats {
  read: number;
  changed: number;
  created: number;
  deleted: number;
  errors: number;
  warnings: number;
  apiCalls: number;
}

export type SyncRunType =
  | "full"
  | "inventory"
  | "prices"
  | "recommendations"
  | "webhook"
  | "product"
  | "export"
  | "showroom";

export class SyncRunTracker {
  private runId: string | null = null;
  private startedAt: Date | null = null;
  private stats: SyncStats = {
    read: 0,
    changed: 0,
    created: 0,
    deleted: 0,
    errors: 0,
    warnings: 0,
    apiCalls: 0,
  };
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  async start(runType: SyncRunType, metadata?: Record<string, unknown>): Promise<string> {
    this.startedAt = new Date();
    this.stats = { read: 0, changed: 0, created: 0, deleted: 0, errors: 0, warnings: 0, apiCalls: 0 };

    const [row] = await db
      .insert(syncRunsTable)
      .values({
        runType,
        status: "running",
        metadata: metadata ?? {},
      })
      .returning({ id: syncRunsTable.id });

    this.runId = row!.id;
    logger.info({ runId: this.runId, runType }, "Sync run started");

    // Flush stats to DB every 30s so progress is visible
    this.flushInterval = setInterval(() => {
      this.flush().catch((err) =>
        logger.warn({ err }, "Failed to flush sync run stats"),
      );
    }, 30_000);

    return this.runId;
  }

  private async flush(): Promise<void> {
    if (!this.runId) return;
    await db
      .update(syncRunsTable)
      .set({
        recordsRead: this.stats.read,
        recordsChanged: this.stats.changed,
        recordsCreated: this.stats.created,
        recordsDeleted: this.stats.deleted,
        errors: this.stats.errors,
        warnings: this.stats.warnings,
        apiCalls: this.stats.apiCalls,
      })
      .where(eq(syncRunsTable.id, this.runId));
  }

  async checkpoint(data: Record<string, unknown>): Promise<void> {
    if (!this.runId) return;
    await db
      .update(syncRunsTable)
      .set({ checkpoint: data })
      .where(eq(syncRunsTable.id, this.runId));
  }

  async complete(): Promise<SyncStats> {
    if (!this.runId) throw new Error("Sync run not started");
    if (this.flushInterval) clearInterval(this.flushInterval);

    const finishedAt = new Date();
    const durationMs = this.startedAt
      ? finishedAt.getTime() - this.startedAt.getTime()
      : null;

    await db
      .update(syncRunsTable)
      .set({
        status: "completed",
        finishedAt,
        durationMs,
        recordsRead: this.stats.read,
        recordsChanged: this.stats.changed,
        recordsCreated: this.stats.created,
        recordsDeleted: this.stats.deleted,
        errors: this.stats.errors,
        warnings: this.stats.warnings,
        apiCalls: this.stats.apiCalls,
      })
      .where(eq(syncRunsTable.id, this.runId));

    logger.info(
      { runId: this.runId, durationMs, ...this.stats },
      "Sync run completed",
    );
    return { ...this.stats };
  }

  async fail(error: Error | unknown): Promise<void> {
    if (!this.runId) return;
    if (this.flushInterval) clearInterval(this.flushInterval);

    const finishedAt = new Date();
    const durationMs = this.startedAt
      ? finishedAt.getTime() - this.startedAt.getTime()
      : null;

    const message = error instanceof Error ? error.message : String(error);

    await db
      .update(syncRunsTable)
      .set({
        status: "failed",
        finishedAt,
        durationMs,
        recordsRead: this.stats.read,
        recordsChanged: this.stats.changed,
        recordsCreated: this.stats.created,
        recordsDeleted: this.stats.deleted,
        errors: this.stats.errors + 1,
        warnings: this.stats.warnings,
        apiCalls: this.stats.apiCalls,
        metadata: sql`metadata || ${JSON.stringify({ failureReason: message })}::jsonb`,
      })
      .where(eq(syncRunsTable.id, this.runId));

    logger.error({ runId: this.runId, error: message, durationMs }, "Sync run failed");
  }

  async logError(params: {
    errorType: string;
    entityType?: string;
    entityId?: string;
    marketCode?: string;
    message: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    this.stats.errors++;
    try {
      await db.insert(syncErrorsTable).values({
        syncRunId: this.runId ?? undefined,
        ...params,
      });
    } catch (err) {
      logger.warn({ err, params }, "Failed to insert sync error");
    }
  }

  // ── Counters ────────────────────────────────────────────────────────────────

  bumpRead(n = 1): void { this.stats.read += n; }
  bumpChanged(n = 1): void { this.stats.changed += n; }
  bumpCreated(n = 1): void { this.stats.created += n; }
  bumpDeleted(n = 1): void { this.stats.deleted += n; }
  bumpWarnings(n = 1): void { this.stats.warnings += n; }
  bumpApiCalls(n = 1): void { this.stats.apiCalls += n; }

  getId(): string {
    if (!this.runId) throw new Error("Sync run not started");
    return this.runId;
  }

  getStats(): Readonly<SyncStats> {
    return { ...this.stats };
  }
}
