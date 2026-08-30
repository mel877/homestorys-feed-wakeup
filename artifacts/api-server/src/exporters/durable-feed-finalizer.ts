import { db, feedSnapshotsTable, type FeedExportStep } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import type { AppConfig } from "../config/schemas";
import {
  createCompressedDerivativeIfLarge,
  passesFeedSnapshotGate,
  uploadImmutableManifest,
  type FeedManifest,
} from "../lib/storage";
import { resolveAlertWebhookUrl, sendFeedBlockAlert } from "../lib/alerting";
import {
  completeFeedExportStep,
  getFeedExportStepById,
  withFeedFinalizationLock,
} from "../jobs/feed-export-step-repository";
import {
  validateGoogleFeed,
  validateMetaFeed,
} from "../validation/feed-validator";
import {
  assembleVersionedFeed,
  type AssembleVersionedFeedOptions,
  type CompletedFeedPart,
} from "./durable-feed-parts";
import {
  resolveDurableFeedFileDefinition,
  resolveExpectedFeedCurrency,
} from "./durable-feed-file-definition";
import { loadVerifiedFeedParts } from "./durable-feed-db-finalizer";

export interface DurableFeedFinalizeOptions {
  syncRunId: string;
  channel: "google" | "meta";
  language: string | null;
  marketCode: string | null;
  version: string;
  currentPath: string;
  versionedPath: string;
  headers: string[];
  delimiter: "," | "\t";
  requiredBatchIndexes: number[];
  parts: CompletedFeedPart[];
  maxDropPct: number;
  dryRun: boolean;
}

export interface DurableFeedValidation {
  valid: boolean;
  errors: unknown[];
}

export interface DurableFeedFinalizeDependencies {
  assemble(
    options: AssembleVersionedFeedOptions,
  ): Promise<{ sha256: string; bytes: number; itemCount: number }>;
  uploadManifest(path: string, manifest: FeedManifest): Promise<void>;
  validate(path: string): Promise<DurableFeedValidation>;
  loadPreviousItemCount(path: string): Promise<number | null>;
  publish(options: {
    versionedPath: string;
    currentPath: string;
    manifest: FeedManifest;
    previousItemCount: number | null;
    maxDropPct: number;
  }): Promise<boolean>;
  recordSnapshot(snapshot: {
    channel: "google" | "meta";
    language: string | null;
    marketCode: string | null;
    storagePath: string;
    itemCount: number;
    sha256: string;
    syncRunId: string;
  }): Promise<void>;
}

export interface DurableFeedFinalizeResult {
  status: "published" | "blocked" | "dry-run";
  published: boolean;
  itemCount: number;
  sha256: string;
  versionedPath: string;
  validationErrors: unknown[];
}

async function finalizeDurableFeedFile(
  options: DurableFeedFinalizeOptions,
  dependencies: DurableFeedFinalizeDependencies,
): Promise<DurableFeedFinalizeResult> {
  // Assembly enforces the batch-completeness barrier before creating output.
  const assembled = await dependencies.assemble({
    outputPath: options.versionedPath,
    headers: options.headers,
    delimiter: options.delimiter,
    requiredBatchIndexes: options.requiredBatchIndexes,
    parts: options.parts,
    immutableOutput: true,
  });

  const manifest: FeedManifest = {
    version: options.version,
    generatedAt: new Date().toISOString(),
    itemCount: assembled.itemCount,
    sha256: assembled.sha256,
    sourceRunId: options.syncRunId,
    channel: options.channel,
    language: options.language,
    marketCode: options.marketCode,
  };
  await dependencies.uploadManifest(options.versionedPath, manifest);

  const validation = await dependencies.validate(options.versionedPath);
  if (!validation.valid) {
    return {
      status: "blocked",
      published: false,
      itemCount: assembled.itemCount,
      sha256: assembled.sha256,
      versionedPath: options.versionedPath,
      validationErrors: validation.errors,
    };
  }

  if (options.dryRun) {
    return {
      status: "dry-run",
      published: false,
      itemCount: assembled.itemCount,
      sha256: assembled.sha256,
      versionedPath: options.versionedPath,
      validationErrors: [],
    };
  }

  const previousItemCount = await dependencies.loadPreviousItemCount(options.currentPath);
  const published = await dependencies.publish({
    versionedPath: options.versionedPath,
    currentPath: options.currentPath,
    manifest,
    previousItemCount,
    maxDropPct: options.maxDropPct,
  });
  if (!published) {
    return {
      status: "blocked",
      published: false,
      itemCount: assembled.itemCount,
      sha256: assembled.sha256,
      versionedPath: options.versionedPath,
      validationErrors: [],
    };
  }

  await dependencies.recordSnapshot({
    channel: options.channel,
    language: options.language,
    marketCode: options.marketCode,
    storagePath: options.versionedPath,
    itemCount: assembled.itemCount,
    sha256: assembled.sha256,
    syncRunId: options.syncRunId,
  });
  return {
    status: "published",
    published: true,
    itemCount: assembled.itemCount,
    sha256: assembled.sha256,
    versionedPath: options.versionedPath,
    validationErrors: [],
  };
}

export const defaultDurableFeedAssembler = assembleVersionedFeed;

export interface ConfiguredDurableFeedFinalizeOptions {
  config: AppConfig;
  syncRunId: string;
  channel: "google" | "meta";
  fileKey: string;
  version: string;
  language: string;
  marketCode: string;
  contributingMarkets: string[];
  requiredBatchIndexes: number[];
  outputVersionedPath: string;
  dryRun: boolean;
}

function resolveSnapshotMarketCode(input: Pick<
  ConfiguredDurableFeedFinalizeOptions,
  "channel" | "fileKey" | "language" | "marketCode"
>): string {
  if (input.channel === "meta" && input.fileKey.startsWith("meta-language-")) {
    return `META_LANGUAGE_${input.language.toUpperCase()}`;
  }
  return input.marketCode;
}

async function finalizeConfiguredDurableFeedFile(
  options: ConfiguredDurableFeedFinalizeOptions,
): Promise<DurableFeedFinalizeResult> {
  const definition = resolveDurableFeedFileDefinition(options);
  const snapshotMarketCode = resolveSnapshotMarketCode(options);
  const expectsCurrency = definition.expectedCurrencyMarket !== null;
  const expectedCurrency = expectsCurrency
    ? resolveExpectedFeedCurrency(
        options.config.markets.markets,
        options.contributingMarkets,
      )
    : undefined;
  const alertWebhookUrl = resolveAlertWebhookUrl(
    options.config.feedPolicy.alerts.webhook_url,
  );
  const parts = await loadVerifiedFeedParts({
    syncRunId: options.syncRunId,
    channel: options.channel,
    marketCode: options.marketCode,
    language: options.language,
    fileKey: options.fileKey,
    versionedPath: definition.versionedPath,
    requiredBatchIndexes: options.requiredBatchIndexes,
  });

  return finalizeDurableFeedFile(
    {
      syncRunId: options.syncRunId,
      channel: options.channel,
      language: options.language || null,
      marketCode: options.marketCode || null,
      version: options.version,
      currentPath: definition.currentPath,
      versionedPath: options.outputVersionedPath,
      headers: definition.headers,
      delimiter: definition.delimiter,
      requiredBatchIndexes: options.requiredBatchIndexes,
      parts,
      maxDropPct: options.config.feedPolicy.snapshot_gate.max_item_count_drop_pct,
      dryRun: options.dryRun,
    },
    {
      assemble: assembleVersionedFeed,
      uploadManifest: uploadImmutableManifest,
      async validate(path) {
        const result = options.channel === "google"
          ? await validateGoogleFeed(path, { expectedCurrency })
          : await validateMetaFeed(path, { expectedCurrency });
        if (!result.valid) {
          await sendFeedBlockAlert(
            {
              channel: options.channel,
              marketOrFile: options.fileKey,
              previousItemCount: null,
              newItemCount: result.rowCount,
              dropPct: null,
              reason: "schema_error",
              syncRunId: options.syncRunId,
            },
            alertWebhookUrl,
          );
        }
        return { valid: result.valid, errors: result.errors };
      },
      async loadPreviousItemCount() {
        const [snapshot] = await db
          .select({ itemCount: feedSnapshotsTable.itemCount })
          .from(feedSnapshotsTable)
          .where(and(
            eq(feedSnapshotsTable.channel, options.channel),
            options.language
              ? eq(feedSnapshotsTable.language, options.language)
              : sql`${feedSnapshotsTable.language} IS NULL`,
            options.marketCode
              ? eq(feedSnapshotsTable.marketCode, snapshotMarketCode)
              : sql`${feedSnapshotsTable.marketCode} IS NULL`,
            eq(feedSnapshotsTable.isCurrent, true),
          ))
          .limit(1);
        return snapshot?.itemCount ?? null;
      },
      async publish(params) {
        const allowed = await passesFeedSnapshotGate({
          currentPath: params.currentPath,
          manifest: params.manifest,
          previousItemCount: params.previousItemCount,
          maxDropPct: params.maxDropPct,
          alertWebhookUrl,
        });
        if (!allowed) return false;
        await createCompressedDerivativeIfLarge(params.versionedPath);
        return true;
      },
      async recordSnapshot(snapshot) {
        await db.transaction(async (tx) => {
          await tx
            .update(feedSnapshotsTable)
            .set({ isCurrent: false })
            .where(and(
              eq(feedSnapshotsTable.channel, snapshot.channel),
              snapshot.language === null
                ? sql`${feedSnapshotsTable.language} IS NULL`
                : eq(feedSnapshotsTable.language, snapshot.language),
              snapshot.marketCode === null
                ? sql`${feedSnapshotsTable.marketCode} IS NULL`
                : eq(feedSnapshotsTable.marketCode, snapshotMarketCode),
            ));
          await tx.insert(feedSnapshotsTable).values({
            ...snapshot,
            marketCode: snapshot.marketCode === null ? null : snapshotMarketCode,
            isCurrent: true,
            generatedAt: new Date(),
          });
        });
      },
    },
  );
}

interface FinalizationCheckpoint {
  fileKey: string;
  version: string;
  requiredBatchIndexes: number[];
  contributingMarkets: string[];
}

export interface DurableFeedFinalizationExecutionDependencies {
  loadStep(stepId: string): Promise<FeedExportStep | null>;
  withLock<T>(lockKey: string, callback: () => Promise<T>): Promise<T | null>;
  finalize(input: ConfiguredDurableFeedFinalizeOptions): Promise<DurableFeedFinalizeResult>;
  completeStep: typeof completeFeedExportStep;
}

export async function executeDurableFeedFinalizationStep(
  input: {
    stepId: string;
    workerId: string;
    config: AppConfig;
    dryRun: boolean;
  },
  dependencies: DurableFeedFinalizationExecutionDependencies = executionDependencies,
): Promise<DurableFeedFinalizeResult> {
  const initial = await dependencies.loadStep(input.stepId);
  assertOwnedFinalizeStep(initial, input.workerId);
  const initialCheckpoint = parseFinalizationCheckpoint(initial.checkpoint);
  const lockKey = [
    "feed-finalize",
    initial.channel,
    initialCheckpoint.fileKey,
  ].join(":");
  const result = await dependencies.withLock(lockKey, async () => {
    const step = await dependencies.loadStep(input.stepId);
    assertOwnedFinalizeStep(step, input.workerId);
    const checkpoint = parseFinalizationCheckpoint(step.checkpoint);
    const definition = resolveDurableFeedFileDefinition({
      channel: step.channel as "google" | "meta",
      fileKey: checkpoint.fileKey,
      version: checkpoint.version,
      language: step.language,
      marketCode: step.marketCode,
    });
    const finalized = await dependencies.finalize({
      config: input.config,
      syncRunId: step.syncRunId,
      channel: step.channel as "google" | "meta",
      fileKey: checkpoint.fileKey,
      version: checkpoint.version,
      language: step.language,
      marketCode: step.marketCode,
      contributingMarkets: checkpoint.contributingMarkets,
      requiredBatchIndexes: checkpoint.requiredBatchIndexes,
      outputVersionedPath:
        `${definition.versionedPath}.final-${step.id}-attempt-${step.attempts}`,
      dryRun: input.dryRun,
    });
    const completed = await dependencies.completeStep(step.id, input.workerId, {
      checkpoint: {
        ...checkpoint,
        result: finalized.status,
        published: finalized.published,
      },
      itemCount: finalized.itemCount,
      sha256: finalized.sha256,
      artifactPath: finalized.versionedPath,
    });
    if (!completed) throw new Error("Finalize step lost its lease before completion");
    return finalized;
  });
  if (!result) {
    throw new Error(`Feed finalization is already running for ${initialCheckpoint.fileKey}`);
  }
  return result;
}

function assertOwnedFinalizeStep(
  step: FeedExportStep | null,
  workerId: string,
): asserts step is FeedExportStep {
  if (
    !step ||
    step.stage !== "finalize" ||
    step.status !== "running" ||
    step.leaseOwner !== workerId ||
    (step.channel !== "google" && step.channel !== "meta")
  ) {
    throw new Error("Finalize step is missing or not owned by this worker");
  }
}

function parseFinalizationCheckpoint(value: unknown): FinalizationCheckpoint {
  if (!value || typeof value !== "object") {
    throw new Error("Finalize step checkpoint is missing");
  }
  const checkpoint = value as Partial<FinalizationCheckpoint>;
  if (
    typeof checkpoint.fileKey !== "string" ||
    typeof checkpoint.version !== "string" ||
    !Array.isArray(checkpoint.requiredBatchIndexes) ||
    !checkpoint.requiredBatchIndexes.every(Number.isInteger) ||
    !Array.isArray(checkpoint.contributingMarkets) ||
    !checkpoint.contributingMarkets.every((market) => typeof market === "string")
  ) {
    throw new Error("Finalize step checkpoint is invalid");
  }
  return checkpoint as FinalizationCheckpoint;
}

const executionDependencies: DurableFeedFinalizationExecutionDependencies = {
  loadStep: getFeedExportStepById,
  withLock: withFeedFinalizationLock,
  finalize: finalizeConfiguredDurableFeedFile,
  completeStep: completeFeedExportStep,
};

export const durableFeedFinalizerTestHooks = process.env.NODE_ENV === "test"
  ? { finalizeDurableFeedFile, resolveSnapshotMarketCode }
  : null;