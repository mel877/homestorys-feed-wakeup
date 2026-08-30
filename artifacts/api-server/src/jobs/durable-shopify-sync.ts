import { randomUUID } from "node:crypto";
import type { ShopifySyncStep } from "@workspace/db";
import { getShopifyClient } from "../shopify/client";
import { SyncRunTracker } from "../shopify/sync-run-tracker";
import { syncProducts } from "../shopify/sync-products";
import { BULK_PRODUCTS_QUERY } from "../shopify/sync-products";
import { createBulkOperation, getBulkOperationById, getCurrentBulkOperation, normalizeBulkQuery } from "../shopify/bulk-ops";
import { syncMarketPricingSlice } from "../shopify/sync-markets";
import { syncInventory } from "../shopify/sync-inventory";
import { BULK_INVENTORY_QUERY } from "../shopify/sync-inventory";
import { syncTranslationsPage } from "../shopify/sync-translations";
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
  renewShopifySyncStepLease,
  releaseExpiredShopifySyncLeases,
  saveShopifySyncStepProgress,
  validateShopifyCompletionGate,
  commitShopifySyncUnit,
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
  renewLease(stepId: string, workerId: string): Promise<boolean>;
  saveProgress(
    stepId: string,
    workerId: string,
    output: {
      cursor?: Record<string, unknown> | null;
      checkpoint?: Record<string, unknown> | null;
    },
  ): Promise<boolean>;
  executePhase(
    step: ShopifySyncClaim["step"],
    context: ShopifyPhaseExecutionContext,
  ): Promise<ShopifyPhaseSliceResult>;
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

export interface ShopifyPhaseExecutionContext {
  workerId: string;
  budgetMs: number;
  deadlineMs: number;
  heartbeat(): Promise<boolean>;
}

export interface ShopifyPhaseSliceResult {
  status: "running" | "completed";
  cursor?: Record<string, unknown> | null;
  checkpoint?: Record<string, unknown> | null;
}

export interface DurableShopifySyncResult {
  status: "running" | "idle" | "completed" | "failed";
  runId: string;
  phase: ShopifySyncPhase | null;
  processed: number;
  reclaimed: number;
  error?: string;
}

export async function executeDefaultPhase(
  step: ShopifySyncClaim["step"],
  context: ShopifyPhaseExecutionContext,
): Promise<ShopifyPhaseSliceResult> {
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
      return executeProductsSlice(step, client, tracker, context);
    case "pricing":
      {
        const result = await withMarketPriceWriteLock(() => syncMarketPricingSlice(
          client,
          tracker,
          checkpointValue(step),
          async () => Date.now() < context.deadlineMs && context.heartbeat(),
          async (checkpoint, writer) => commitShopifySyncUnit({
            stepId: step.id,
            workerId: context.workerId,
            checkpoint,
            writer,
          }),
        ));
        return result.completed
          ? { status: "completed", checkpoint: result.checkpoint }
          : { status: "running", checkpoint: result.checkpoint };
      }
    case "inventory":
      return executeInventorySlice(step, client, tracker, context);
    case "translations":
      {
        const savedCursor = step.cursor as Record<string, unknown> | null;
        const result = await syncTranslationsPage(client, tracker, {
          localeIndex: typeof savedCursor?.localeIndex === "number" ? savedCursor.localeIndex : 0,
          cursor: typeof savedCursor?.cursor === "string" ? savedCursor.cursor : null,
          resourceIndex: typeof savedCursor?.resourceIndex === "number"
            ? savedCursor.resourceIndex : undefined,
          page: Array.isArray(savedCursor?.page) ? savedCursor.page as never[] : undefined,
          nextPageCursor: typeof savedCursor?.nextPageCursor === "string"
            ? savedCursor.nextPageCursor : null,
        }, async () => Date.now() < context.deadlineMs && context.heartbeat());
        return result.completed
          ? { status: "completed", checkpoint: { completedAt: new Date().toISOString() } }
          : { status: "running", cursor: { ...result.cursor } };
      }
    case "images":
      if (!await context.heartbeat()) return { status: "running", checkpoint: checkpointValue(step) };
      const imageResult = await classifyStoredImages({
        maxPages: 1,
        beforeChunk: async () => Date.now() < context.deadlineMs && context.heartbeat(),
      });
      return imageResult.pages === 0
        ? { status: "completed", checkpoint: { completedAt: new Date().toISOString() } }
        : { status: "running", checkpoint: { pagesProcessed: imageResult.pages } };
    case "completion":
      break;
  }
  return {
    status: "completed",
    checkpoint: {
      completedAt: new Date().toISOString(),
      ...(step.checkpoint && typeof step.checkpoint === "object"
        ? { resumedFrom: step.checkpoint }
        : {}),
    },
  };
}

function checkpointValue(
  step: ShopifySyncClaim["step"],
): Record<string, unknown> {
  return step.checkpoint && typeof step.checkpoint === "object"
    ? step.checkpoint as Record<string, unknown>
    : {};
}

async function executeProductsSlice(
  step: ShopifySyncClaim["step"],
  client: ReturnType<typeof getShopifyClient>,
  tracker: SyncRunTracker,
  context: ShopifyPhaseExecutionContext,
): Promise<ShopifyPhaseSliceResult> {
  const checkpoint = checkpointValue(step);
  if (step.attempts > 1 && !step.checkpoint && !step.cursor) {
    throw new Error("legacy-recovery: products step has no durable checkpoint; manual recovery required");
  }
  let operationId = typeof checkpoint.operationId === "string"
    ? checkpoint.operationId
    : undefined;
  let resultUrl = typeof checkpoint.resultUrl === "string"
    ? checkpoint.resultUrl
    : undefined;

  if (!operationId) {
    if (!await context.heartbeat()) return { status: "running", checkpoint };
    const current = await getCurrentBulkOperation(client);
    if (current) {
      if (normalizeBulkQuery(current.query ?? "") !== normalizeBulkQuery(BULK_PRODUCTS_QUERY)) {
        throw new Error("Cannot create products bulk operation: an unrelated Shopify bulk operation is active");
      }
      return {
        status: "running",
        checkpoint: { ...checkpoint, stage: "polling", operationId: current.id },
      };
    }
    operationId = await createBulkOperation(client, BULK_PRODUCTS_QUERY);
    return {
      status: "running",
      checkpoint: { ...checkpoint, stage: "polling", operationId },
    };
  }
  if (!resultUrl) {
    if (!await context.heartbeat()) return { status: "running", checkpoint };
    // One request only: never use the legacy long-poll helper in a HTTP slice.
    const operation = await getBulkOperationById(client, operationId);
    if (!operation ||
      !["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(operation.status)) {
      return { status: "running", checkpoint: { ...checkpoint, stage: "polling", operationId } };
    }
    if (operation.status !== "COMPLETED") {
      throw new Error(`Bulk operation ended with status: ${operation.status}`);
    }
    if (!operation.url) {
      return { status: "completed", checkpoint: { ...checkpoint, stage: "complete", operationId } };
    }
    resultUrl = operation.url;
  }
  const cursor = step.cursor as Record<string, unknown> | null;
  const startBatchIndex = typeof cursor?.nextBatchIndex === "number"
    ? cursor.nextBatchIndex
    : 0;
  const byteOffset = typeof cursor?.byteOffset === "number" ? cursor.byteOffset : 0;
  const result = await syncProducts(client, tracker, {
    bulkResultUrl: resultUrl,
    startBatchIndex,
    byteOffset,
    seenProductGids: Array.isArray(cursor?.seenProductGids)
      ? cursor.seenProductGids.filter((gid): gid is string => typeof gid === "string")
      : [],
    finalized: cursor?.finalized === true,
    pendingProductGroup: cursor?.pendingProductGroup as never,
    beforeBatch: async () => Date.now() < context.deadlineMs && context.heartbeat(),
    beforeFinalize: async () => Date.now() < context.deadlineMs && context.heartbeat(),
    commitUnit: async (cursor, writer) => commitShopifySyncUnit({
      stepId: step.id,
      workerId: context.workerId,
      cursor,
      checkpoint: { stage: "batches", operationId, resultUrl },
      writer,
    }),
  });
  const next = {
    stage: result.completed ? "complete" : "batches",
    operationId,
    resultUrl,
  };
  return result.completed
    ? {
      status: "completed",
      cursor: {
        byteOffset: result.byteOffset ?? byteOffset,
        ...(result.seenProductGids ? { seenProductGids: result.seenProductGids } : {}),
        ...(result.pendingProductGroup ? { pendingProductGroup: result.pendingProductGroup } : {}),
        ...(result.finalized ? { finalized: true } : {}),
      },
      checkpoint: next,
    }
    : {
      status: "running",
      cursor: {
        byteOffset: result.byteOffset ?? byteOffset,
        ...(result.seenProductGids ? { seenProductGids: result.seenProductGids } : {}),
        ...(result.pendingProductGroup ? { pendingProductGroup: result.pendingProductGroup } : {}),
        ...(result.finalized ? { finalized: true } : {}),
      },
      checkpoint: next,
    };
}

async function executeInventorySlice(
  step: ShopifySyncClaim["step"],
  client: ReturnType<typeof getShopifyClient>,
  tracker: SyncRunTracker,
  context: ShopifyPhaseExecutionContext,
): Promise<ShopifyPhaseSliceResult> {
  const checkpoint = checkpointValue(step);
  let operationId = typeof checkpoint.operationId === "string" ? checkpoint.operationId : undefined;
  let resultUrl = typeof checkpoint.resultUrl === "string" ? checkpoint.resultUrl : undefined;
  if (!operationId) {
    if (!await context.heartbeat()) return { status: "running", checkpoint };
    const current = await getCurrentBulkOperation(client);
    if (current) {
      if (normalizeBulkQuery(current.query ?? "") !== normalizeBulkQuery(BULK_INVENTORY_QUERY)) {
        throw new Error("Cannot create inventory bulk operation: an unrelated Shopify bulk operation is active");
      }
      return { status: "running", checkpoint: { ...checkpoint, stage: "polling", operationId: current.id } };
    }
    operationId = await createBulkOperation(client, BULK_INVENTORY_QUERY);
    return { status: "running", checkpoint: { ...checkpoint, stage: "polling", operationId } };
  }
  if (!resultUrl) {
    if (!await context.heartbeat()) return { status: "running", checkpoint };
    const operation = await getBulkOperationById(client, operationId);
    if (!operation ||
      !["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(operation.status)) {
      return { status: "running", checkpoint: { ...checkpoint, stage: "polling", operationId } };
    }
    if (operation.status !== "COMPLETED") throw new Error(`Bulk operation ended with status: ${operation.status}`);
    if (!operation.url) return { status: "completed", checkpoint: { ...checkpoint, stage: "complete", operationId } };
    resultUrl = operation.url;
  }
  const cursor = step.cursor as Record<string, unknown> | null;
  const startBatchIndex = typeof cursor?.nextBatchIndex === "number" ? cursor.nextBatchIndex : 0;
  const byteOffset = typeof cursor?.byteOffset === "number" ? cursor.byteOffset : 0;
  const result = await syncInventory(client, tracker, {
    bulkResultUrl: resultUrl,
    startBatchIndex,
    byteOffset,
    finalized: cursor?.finalized === true,
    pendingInventoryGroup: cursor?.pendingInventoryGroup as never,
    beforeBatch: async () => Date.now() < context.deadlineMs && context.heartbeat(),
    beforeFinalize: async () => Date.now() < context.deadlineMs && context.heartbeat(),
    commitUnit: async (cursor, writer) => commitShopifySyncUnit({
      stepId: step.id,
      workerId: context.workerId,
      cursor,
      checkpoint: { stage: "batches", operationId, resultUrl },
      writer,
    }),
  });
  const next = { stage: result.completed ? "complete" : "batches", operationId, resultUrl };
  return result.completed
    ? {
      status: "completed",
      cursor: {
        byteOffset: result.byteOffset ?? byteOffset,
        ...(result.finalized ? { finalized: true } : {}),
        ...(result.pendingInventoryGroup ? { pendingInventoryGroup: result.pendingInventoryGroup } : {}),
      },
      checkpoint: next,
    }
    : {
      status: "running",
      cursor: {
        byteOffset: result.byteOffset ?? byteOffset,
        ...(result.pendingInventoryGroup ? { pendingInventoryGroup: result.pendingInventoryGroup } : {}),
        ...(result.finalized ? { finalized: true } : {}),
      },
      checkpoint: next,
    };
}

const defaultDependencies: DurableShopifySyncDependencies = {
  ensureRun: ensureDurableShopifyRun,
  releaseExpiredLeases: releaseExpiredShopifySyncLeases,
  claimNext: async (runId, workerId) =>
    claimNextShopifySyncStep(runId, workerId) as Promise<ShopifySyncClaim | null>,
  renewLease: renewShopifySyncStepLease,
  saveProgress: saveShopifySyncStepProgress,
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
    budgetMs?: number;
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
  const budgetMs = Math.min(Math.max(1_000, options.budgetMs ?? 25_000), 35_000);
  const deadlineMs = Date.now() + budgetMs;

  for (let index = 0; index < maxSteps; index++) {
    const claim = await dependencies.claimNext(runId, workerId);
    if (!claim) break;
    phase = claim.step.phase;
    try {
      const renewed = await dependencies.renewLease(claim.step.id, workerId);
      if (!renewed) {
        return {
          status: "running",
          runId,
          phase,
          processed,
          reclaimed,
          error: "Shopify step lease ownership was lost",
        };
      }
      const output = await dependencies.executePhase(claim.step, {
        workerId,
        budgetMs,
        deadlineMs,
        heartbeat: () => dependencies.renewLease(claim.step.id, workerId),
      });
      if (output.status === "running") {
        const saved = await dependencies.saveProgress(
          claim.step.id,
          workerId,
          {
            cursor: output.cursor,
            checkpoint: output.checkpoint,
          },
        );
        return {
          status: "running",
          runId,
          phase,
          processed,
          reclaimed,
          ...(!saved
            ? { error: "Shopify step lease ownership was lost" }
            : {}),
        };
      }
      const completed = await dependencies.completeStep(
        claim.step.id,
        workerId,
        { checkpoint: output.checkpoint },
      );
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