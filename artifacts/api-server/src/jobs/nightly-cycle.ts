import { randomUUID } from "node:crypto";
import { planDurableFeedRun } from "./durable-feed-planner";
import { runDurableFeedPump } from "./durable-feed-pump";
import { getFeedExportStepSummary, completeFeedExportRun } from "./feed-export-step-repository";
import {
  runDurableShopifySyncSlice,
  type DurableShopifySyncResult,
} from "./durable-shopify-sync";

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
  getFeedSummary(runId: string): Promise<{
    total: number;
    pending: number;
    running: number;
    completed: number;
  completeFeedRun(runId: string): Promise<void>;
  completeFeedRun(runId: string): Promise<void>;
    failed: number;
  }>;
}

export interface NightlyCycleResult {
  status: "running" | "idle" | "completed" | "failed";
  phase: "shopify" | "products" | "pricing" | "inventory" | "translations" | "images" | "completion" | "feeds";
  sourceSyncRunId: string;
  feedRunId?: string;
  error?: string;
}

const defaultDependencies: NightlyCycleDependencies = {
  advanceShopify: runDurableShopifySyncSlice,
  planFeed: (options) => planDurableFeedRun(options),
  pumpFeed: runDurableFeedPump,
  getFeedSummary: getFeedExportStepSummary,
  completeFeedRun: completeFeedExportRun,
};

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
    return {
      status: "running",
      phase: "feeds",
      sourceSyncRunId: shopify.runId,
      error: "another durable feed cycle is still active",
    };
  }

  const pump = await dependencies.pumpFeed({
    workerId: `${workerId}-feed`,
    budgetMs: 40_000,
    maxSteps: 8,
  });
  const summary = await dependencies.getFeedSummary(plan.runId);
  if (summary.failed > 0 || pump.status === "error") {
    return {
      status: "failed",
      phase: "feeds",
      sourceSyncRunId: shopify.runId,
      feedRunId: plan.runId,
      error: pump.error ?? "durable feed step failed",
    };
  }
  if (summary.total > 0 && summary.completed === summary.total) {
    await dependencies.completeFeedRun(plan.runId);
    return {
      status: "completed",
      phase: "feeds",
      sourceSyncRunId: shopify.runId,
      feedRunId: plan.runId,
    };
  }
  return {
    status: pump.status === "idle" ? "idle" : "running",
    phase: "feeds",
    sourceSyncRunId: shopify.runId,
    feedRunId: plan.runId,
  };
}