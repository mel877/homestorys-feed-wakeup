import { randomUUID } from "node:crypto";
import type { ShopifySyncStep } from "@workspace/db";
import { getShopifyClient } from "../shopify/client";
import { SyncRunTracker } from "../shopify/sync-run-tracker";
import { syncProducts } from "../shopify/sync-products";
import { syncMarketPricing } from "../shopify/sync-markets";
import { syncInventory } from "../shopify/sync-inventory";
import { syncTranslations } from "../shopify/sync-translations";
import { classifyStoredImages } from "../images/classify-stored";
import { withMarketPriceWriteLock } from "../shopify/market-price-write-lock";
import {
  SHOPIFY_PHASES,
  claimNextShopifySyncStep,
  completeDurableShopifyRun,
  completeShopifySyncStep,
  ensureDurableShopifyRun,
  failDurableShopifyRun,
  failShopifySyncStep,
  getShopifySyncStepSummary,
  releaseExpiredShopifySyncLeases,
  validateShopifyCompletionGate,
  type ShopifySyncPhase,
} from "./shopify-sync-step-repository";

export const REQUIRED_SHOPIFY_PHASES = SHOPIFY_PHASES;
export const MAX_SHOPIFY_SLICE_STEPS = 2;

export interface ShopifySyncClaim {
  step: ShopifySyncStep & { phase: ShopifySyncPhase };
  reclaimed: boolean;
}

export interface ShopifyStepSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface DurableShopifySyncDependencies {
  ensureRun(cycleKey: string): Promise<{ runId: string; created: boolean }>;
  releaseExpiredLeases(): Promise<number>;
  claimNext(runId: string, workerId: string): Promise<ShopifySyncClaim | null>;
  executePhase(
    step: ShopifySyncClaim["step"],
    workerId: string,
  ): Promise<{ checkpoint?: Record<string, unknown> | null }>;
  completeStep(
    stepId: string,
    workerId: string,
    output: { checkpoint?: Record<string, unknown> | null },
  ): Promise<boolean>;
  failStep(
    stepId: string,
    workerId: string,
    error: unknown,
  ): Promise<"retry" | "failed" | "conflict">;
  getSummary(runId: string): Promise<ShopifyStepSummary>;
  validateGate(runId: string): Promise<{ ok: boolean; reasons: string[] }>;
  completeRun(runId: string): Promise<void>;
  failRun(runId: string, reasons: string[]): Promise<void>;
}

export interface DurableShopifySyncResult {
  status: "running" | "idle" | "completed" | "failed";
  runId: string;
  phase: ShopifySyncPhase | null;
  processed: number;
  reclaimed: number;
  error?: string;
}

async function executeDefaultPhase(
  step: ShopifySyncClaim["step"],
): Promise<{ checkpoint: Record<string, unknown> }> {
  const client = getShopifyClient();
  const tracker = new SyncRunTracker();
  tracker.attach(step.syncRunId);

  switch (step.phase) {
    case "products":
      await client.validateScopes([
        "read_products",
        "read_inventory",
        "read_markets",
        "read_translations",
        "read_locales",
      ]);
      await syncProducts(client, tracker);
      break;
    case "pricing":
      await withMarketPriceWriteLock(() => syncMarketPricing(client, tracker));
      break;
    case "inventory":
      await syncInventory(client, tracker);
      break;
    case "translations":
      await syncTranslations(client, tracker);
      break;
    case "images":
      await classifyStoredImages();
      break;
    case "completion":
      break;
  }
  return {
    checkpoint: {
      completedAt: new Date().toISOString(),
      ...(step.checkpoint && typeof step.checkpoint === "object"
        ? { resumedFrom: step.checkpoint }
        : {}),
    },
  };
}

const defaultDependencies: DurableShopifySyncDependencies = {
  ensureRun: ensureDurableShopifyRun,
  releaseExpiredLeases: releaseExpiredShopifySyncLeases,
  claimNext: async (runId, workerId) =>
    claimNextShopifySyncStep(runId, workerId) as Promise<ShopifySyncClaim | null>,
  executePhase: executeDefaultPhase,
  completeStep: completeShopifySyncStep,
  failStep: failShopifySyncStep,
  getSummary: getShopifySyncStepSummary,
  validateGate: validateShopifyCompletionGate,
  completeRun: completeDurableShopifyRun,
  failRun: failDurableShopifyRun,
};

export async function runDurableShopifySyncSlice(
  options: {
    cycleKey: string;
    workerId?: string;
    maxSteps?: number;
  },
  dependencies: DurableShopifySyncDependencies = defaultDependencies,
): Promise<DurableShopifySyncResult> {
  const workerId = options.workerId ?? `shopify-pump-${randomUUID()}`;
  const maxSteps = Math.min(
    Math.max(1, options.maxSteps ?? 1),
    MAX_SHOPIFY_SLICE_STEPS,
  );
  const { runId } = await dependencies.ensureRun(options.cycleKey);
  const reclaimed = await dependencies.releaseExpiredLeases();
  let processed = 0;
  let phase: ShopifySyncPhase | null = null;

  for (let index = 0; index < maxSteps; index++) {
    const claim = await dependencies.claimNext(runId, workerId);
    if (!claim) break;
    phase = claim.step.phase;
    try {
      const output = await dependencies.executePhase(claim.step, workerId);
      const completed = await dependencies.completeStep(claim.step.id, workerId, output);
      if (!completed) {
        return {
          status: "running",
          runId,
          phase,
          processed,
          reclaimed,
          error: "Shopify step lease ownership was lost",
        };
      }
      processed++;
    } catch (error) {
      const failure = await dependencies.failStep(
        claim.step.id,
        workerId,
        error,
      );
      if (failure === "failed") {
        const message = error instanceof Error ? error.message : String(error);
        await dependencies.failRun(runId, [message]);
        return {
          status: "failed",
          runId,
          phase,
          processed,
          reclaimed,
          error: message,
        };
      }
      return {
        status: "running",
        runId,
        phase,
        processed,
        reclaimed,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const summary = await dependencies.getSummary(runId);
  if (summary.failed > 0) {
    await dependencies.failRun(runId, ["mandatory Shopify step failed"]);
    return {
      status: "failed",
      runId,
      phase,
      processed,
      reclaimed,
      error: "mandatory Shopify step failed",
    };
  }
  if (summary.total === REQUIRED_SHOPIFY_PHASES.length
      && summary.completed === REQUIRED_SHOPIFY_PHASES.length) {
    const gate = await dependencies.validateGate(runId);
    if (!gate.ok) {
      await dependencies.failRun(runId, gate.reasons);
      return {
        status: "failed",
        runId,
        phase: "completion",
        processed,
        reclaimed,
        error: gate.reasons.join("; "),
      };
    }
    await dependencies.completeRun(runId);
    return {
      status: "completed",
      runId,
      phase: "completion",
      processed,
      reclaimed,
    };
  }
  return {
    status: processed > 0 ? "running" : "idle",
    runId,
    phase,
    processed,
    reclaimed,
  };
}