import { randomUUID } from "node:crypto";
import { planDurableFeedRun } from "./durable-feed-planner";
import { runDurableFeedPump } from "./durable-feed-pump";
import {
  completeFeedExportRun,
  failFeedExportRun,
  findActiveDurableFeedRun,
  getFeedExportStepSummary,
  listUnpublishedFeedFiles,
  settleDurableFeedRun,
  type SettledDurableFeedRun,
} from "./feed-export-step-repository";
import {
  runDurableShopifySyncSlice,
  type DurableShopifySyncResult,
} from "./durable-shopify-sync";

export interface FeedRunSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface NightlyCycleDependencies {
  advanceShopify(options: {
    cycleKey: string;
    workerId: string;
    maxSteps: number;
  }): Promise<DurableShopifySyncResult>;
  planFeed(options: {
    trigger: "nightly";
    sourceSyncRunId: string;
    idempotencyKey: string;
  }): Promise<{
    status: "planned" | "existing" | "conflict";
    runId?: string;
    totalSteps: number;
  }>;
  pumpFeed(options: {
    workerId: string;
    budgetMs: number;
    maxSteps: number;
  }): Promise<{ status: string; processed: number; error?: string }>;
  getFeedSummary(runId: string): Promise<FeedRunSummary>;
  completeFeedRun(runId: string): Promise<void>;
  failFeedRun(runId: string, reason: string): Promise<void>;
  settleFeedRun(runId: string): Promise<SettledDurableFeedRun>;
  findActiveFeedRun(): Promise<{ runId: string } | null>;
  listUnpublishedFiles(runId: string): Promise<Array<{ fileKey: string; result: string }>>;
}

export interface NightlyCycleResult {
  status: "running" | "idle" | "completed" | "failed";
  phase: "shopify" | "products" | "pricing" | "inventory" | "translations" | "images" | "completion" | "feeds";
  sourceSyncRunId: string;
  feedRunId?: string;
  blockingFeedRunId?: string;
  summary?: FeedRunSummary;
  unpublishedFiles?: Array<{ fileKey: string; result: string }>;
  stuckSteps?: SettledDurableFeedRun["stuckSteps"];
  error?: string;
}

const defaultDependencies: NightlyCycleDependencies = {
  advanceShopify: runDurableShopifySyncSlice,
  planFeed: (options) => planDurableFeedRun(options),
  pumpFeed: runDurableFeedPump,
  getFeedSummary: getFeedExportStepSummary,
  completeFeedRun: completeFeedExportRun,
  failFeedRun: failFeedExportRun,
  settleFeedRun: settleDurableFeedRun,
  findActiveFeedRun: findActiveDurableFeedRun,
  listUnpublishedFiles: listUnpublishedFeedFiles,
};

interface DrivenFeedRun {
  status: "running" | "idle" | "completed" | "failed";
  summary: FeedRunSummary;
  unpublishedFiles?: Array<{ fileKey: string; result: string }>;
  stuckSteps?: SettledDurableFeedRun["stuckSteps"];
  error?: string;
}

/**
 * Advances one durable feed run and always drives it to a terminal state:
 * a run with a failed step or a deadlock is marked failed so it can never
 * block the next nightly plan again.
 */
async function driveFeedRun(
  runId: string,
  workerId: string,
  dependencies: NightlyCycleDependencies,
): Promise<DrivenFeedRun> {
  const pump = await dependencies.pumpFeed({
    workerId,
    budgetMs: 40_000,
    maxSteps: 8,
  });
  const settled = await dependencies.settleFeedRun(runId);
  const summary = await dependencies.getFeedSummary(runId);

  if (summary.failed > 0) {
    const error = pump.error ?? "durable feed step failed";
    await dependencies.failFeedRun(runId, error);
    return {
      status: "failed",
      summary,
      unpublishedFiles: await dependencies.listUnpublishedFiles(runId),
      error,
    };
  }
  if (summary.total > 0 && summary.completed === summary.total) {
    await dependencies.completeFeedRun(runId);
    const unpublishedFiles = await dependencies.listUnpublishedFiles(runId);
    return {
      status: "completed",
      summary,
      ...(unpublishedFiles.length > 0 ? { unpublishedFiles } : {}),
    };
  }
  if (summary.total === 0 || settled.stuckSteps.length > 0) {
    const error = summary.total === 0
      ? "durable feed run has no steps"
      : `durable feed run is deadlocked: ${summary.pending} pending step(s) can never be claimed`;
    await dependencies.failFeedRun(runId, error);
    return {
      status: "failed",
      summary,
      stuckSteps: settled.stuckSteps,
      error,
    };
  }
  const progressed = pump.processed > 0 || settled.skipped > 0;
  return {
    status: progressed || pump.status !== "idle" ? "running" : "idle",
    summary,
    ...(pump.error ? { error: pump.error } : {}),
  };
}

export async function advanceNightlyCycle(
  options: {
    cycleKey: string;
    workerId?: string;
  },
  dependencies: NightlyCycleDependencies = defaultDependencies,
): Promise<NightlyCycleResult> {
  const workerId = options.workerId ?? `nightly-${randomUUID()}`;
  const shopify = await dependencies.advanceShopify({
    cycleKey: options.cycleKey,
    workerId: `${workerId}-shopify`,
    maxSteps: 1,
  });
  if (shopify.status === "failed") {
    return {
      status: "failed",
      phase: shopify.phase ?? "shopify",
      sourceSyncRunId: shopify.runId,
      error: shopify.error,
    };
  }
  if (shopify.status !== "completed") {
    return {
      status: shopify.status,
      phase: shopify.phase ?? "shopify",
      sourceSyncRunId: shopify.runId,
      error: shopify.error,
    };
  }

  const plan = await dependencies.planFeed({
    trigger: "nightly",
    sourceSyncRunId: shopify.runId,
    idempotencyKey: shopify.runId,
  });
  if (plan.status === "conflict" || !plan.runId) {
    // An older run still holds the plan slot. Drive it to a terminal state
    // instead of waiting on it: nothing else would ever advance it.
    const active = await dependencies.findActiveFeedRun();
    if (!active) {
      return {
        status: "running",
        phase: "feeds",
        sourceSyncRunId: shopify.runId,
        error: "another durable feed cycle is still active",
      };
    }
    const previous = await driveFeedRun(active.runId, `${workerId}-feed`, dependencies);
    return {
      status: "running",
      phase: "feeds",
      sourceSyncRunId: shopify.runId,
      blockingFeedRunId: active.runId,
      summary: previous.summary,
      error: `previous durable feed run ${active.runId} is ${previous.status}`
        + (previous.error ? `: ${previous.error}` : ""),
    };
  }

  const driven = await driveFeedRun(plan.runId, `${workerId}-feed`, dependencies);
  return {
    status: driven.status,
    phase: "feeds",
    sourceSyncRunId: shopify.runId,
    feedRunId: plan.runId,
    summary: driven.summary,
    ...(driven.unpublishedFiles ? { unpublishedFiles: driven.unpublishedFiles } : {}),
    ...(driven.stuckSteps ? { stuckSteps: driven.stuckSteps } : {}),
    ...(driven.error ? { error: driven.error } : {}),
  };
}
