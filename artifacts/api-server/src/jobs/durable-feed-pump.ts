import { randomUUID } from "node:crypto";
import { loadConfig, type AppConfig } from "../config";
import {
  claimNextFeedExportStep,
  deferFeedExportStep,
  failFeedExportStep,
  releaseExpiredFeedExportLeases,
  type FeedExportStepResult,
} from "./feed-export-step-repository";
import {
  executeGoogleFeedBuildStep,
  executeMetaFeedBuildStep,
} from "../exporters/durable-feed-builders";
import { executeDurableFeedFinalizationStep } from "../exporters/durable-feed-finalizer";

export const DEFAULT_PUMP_BUDGET_MS = 30_000;
export const MAX_PUMP_BUDGET_MS = 40_000;
export const DEFAULT_PUMP_MAX_STEPS = 4;
export const MAX_PUMP_STEPS = 24;
export const MAX_PUMP_CONCURRENCY = 4;

export type PumpStatus =
  | "idle"
  | "processed"
  | "retry"
  | "transient_error"
  | "conflict"
  | "error";

export interface PumpClaim extends FeedExportStepResult {}

export interface DurableFeedPumpResult {
  status: PumpStatus;
  processed: number;
  reclaimed: number;
  elapsedMs: number;
  remainingBudgetMs: number;
  steps: Array<{
    id: string;
    stage: string;
    channel: string;
    status: "processed" | "retry" | "conflict" | "error";
    reclaimed: boolean;
  }>;
  error?: string;
}

export interface DurableFeedPumpOptions {
  workerId?: string;
  budgetMs?: number;
  maxSteps?: number;
  /** Steps processed in parallel inside one request (default 1). */
  concurrency?: number;
  config?: AppConfig;
}

export interface DurableFeedPumpDependencies {
  recoverExpired(): Promise<number>;
  claimNext(workerId: string): Promise<PumpClaim | null>;
  executeBuild(
    step: PumpClaim["step"],
    workerId: string,
    config: AppConfig,
  ): Promise<unknown>;
  executeFinalize(
    step: PumpClaim["step"],
    workerId: string,
    config: AppConfig,
  ): Promise<unknown>;
  failStep(
    stepId: string,
    workerId: string,
    error: unknown,
  ): Promise<"retry" | "failed" | "conflict">;
  deferStep(stepId: string, workerId: string): Promise<boolean>;
  now(): number;
}

function defaultDependencies(): DurableFeedPumpDependencies {
  return {
    recoverExpired: releaseExpiredFeedExportLeases,
    claimNext: async (workerId) => claimNextFeedExportStep(workerId),
    executeBuild: async (step, workerId, config) => {
      if (step.channel === "google") {
        return executeGoogleFeedBuildStep(
          step as unknown as Parameters<typeof executeGoogleFeedBuildStep>[0],
          workerId,
          config,
        );
      }
      return executeMetaFeedBuildStep(
        step as unknown as Parameters<typeof executeMetaFeedBuildStep>[0],
        workerId,
        config,
      );
    },
    executeFinalize: async (step, workerId, config) =>
      executeDurableFeedFinalizationStep({
        stepId: step.id,
        workerId,
        config,
        dryRun: false,
      }),
    failStep: failFeedExportStep,
    deferStep: deferFeedExportStep,
    now: Date.now,
  };
}

export async function runDurableFeedPump(
  options: DurableFeedPumpOptions = {},
  dependencies: DurableFeedPumpDependencies = defaultDependencies(),
): Promise<DurableFeedPumpResult> {
  const startedAt = dependencies.now();
  const budgetMs = Math.min(
    Math.max(1_000, options.budgetMs ?? DEFAULT_PUMP_BUDGET_MS),
    MAX_PUMP_BUDGET_MS,
  );
  const maxSteps = Math.min(
    Math.max(1, options.maxSteps ?? DEFAULT_PUMP_MAX_STEPS),
    MAX_PUMP_STEPS,
  );
  const workerId = options.workerId ?? `feed-pump-${randomUUID()}`;
  const config = options.config ?? loadConfig();
  const concurrency = Math.min(
    Math.max(1, Math.floor(options.concurrency ?? 1)),
    MAX_PUMP_CONCURRENCY,
  );
  const reclaimed = await dependencies.recoverExpired();
  const steps: DurableFeedPumpResult["steps"] = [];
  let processed = 0;
  let started = 0;
  let stopped: DurableFeedPumpResult | null = null;

  const stop = (status: PumpStatus, error: string) => {
    if (stopped) return;
    const elapsedMs = Math.max(0, dependencies.now() - startedAt);
    stopped = {
      status,
      processed,
      reclaimed,
      elapsedMs,
      remainingBudgetMs: Math.max(0, budgetMs - elapsedMs),
      steps,
      error,
    };
  };

  // Each lane claims and runs steps one after the other. Build steps are
  // mostly DB and storage I/O, so a few lanes finish a run several times
  // faster than a single sequential loop. Claims use row locks, so lanes
  // never receive the same step.
  const lane = async () => {
    while (
      !stopped &&
      started < maxSteps &&
      dependencies.now() - startedAt < budgetMs
    ) {
      started++;
      const claimed = await dependencies.claimNext(workerId);
      if (!claimed) {
        started--;
        return;
      }

      try {
        if (claimed.step.stage === "build") {
          await dependencies.executeBuild(claimed.step, workerId, config);
        } else if (claimed.step.stage === "finalize") {
          await dependencies.executeFinalize(claimed.step, workerId, config);
        } else {
          throw new Error(`Unsupported durable feed step stage: ${claimed.step.stage}`);
        }
        steps.push({
          id: claimed.step.id,
          stage: claimed.step.stage,
          channel: claimed.step.channel,
          status: "processed",
          reclaimed: claimed.reclaimed,
        });
        processed++;
      } catch (error) {
        const finalizationConflict = claimed.step.stage === "finalize"
          && error instanceof Error
          && error.message.startsWith("Feed finalization is already running for ");
        if (finalizationConflict) {
          await dependencies.deferStep(claimed.step.id, workerId);
          steps.push({
            id: claimed.step.id,
            stage: claimed.step.stage,
            channel: claimed.step.channel,
            status: "conflict",
            reclaimed: claimed.reclaimed,
          });
          stop("conflict", error.message);
          return;
        }
        const isUnsupportedStage = claimed.step.stage !== "build"
          && claimed.step.stage !== "finalize";
        const failureStatus = await dependencies.failStep(
          claimed.step.id,
          workerId,
          error,
        );
        const status = isUnsupportedStage
          ? "error"
          : failureStatus === "retry"
            ? "retry"
            : failureStatus === "conflict"
              ? "conflict"
              : "error";
        steps.push({
          id: claimed.step.id,
          stage: claimed.step.stage,
          channel: claimed.step.channel,
          status,
          reclaimed: claimed.reclaimed,
        });
        stop(status, error instanceof Error ? error.message : String(error));
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => lane()));
  if (stopped) {
    const result = stopped as DurableFeedPumpResult;
    return { ...result, processed, steps };
  }

  const elapsedMs = Math.max(0, dependencies.now() - startedAt);
  return {
    status: processed > 0 ? "processed" : "idle",
    processed,
    reclaimed,
    elapsedMs,
    remainingBudgetMs: Math.max(0, budgetMs - elapsedMs),
    steps,
  };
}