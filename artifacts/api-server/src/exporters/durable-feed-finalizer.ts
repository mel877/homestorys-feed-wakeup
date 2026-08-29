import { db, feedSnapshotsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../config/schemas";
import {
  atomicPublish,
  downloadManifest,
  uploadManifest,
  type FeedManifest,
} from "../lib/storage";
import { resolveAlertWebhookUrl, sendFeedBlockAlert } from "../lib/alerting";
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

export async function finalizeDurableFeedFile(
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
    storagePath: options.currentPath,
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
  parts: CompletedFeedPart[];
  dryRun: boolean;
}

export async function finalizeConfiguredDurableFeedFile(
  options: ConfiguredDurableFeedFinalizeOptions,
): Promise<DurableFeedFinalizeResult> {
  const definition = resolveDurableFeedFileDefinition(options);
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

  return finalizeDurableFeedFile(
    {
      syncRunId: options.syncRunId,
      channel: options.channel,
      language: options.language || null,
      marketCode: options.marketCode || null,
      version: options.version,
      currentPath: definition.currentPath,
      versionedPath: definition.versionedPath,
      headers: definition.headers,
      delimiter: definition.delimiter,
      requiredBatchIndexes: options.requiredBatchIndexes,
      parts: options.parts,
      maxDropPct: options.config.feedPolicy.snapshot_gate.max_item_count_drop_pct,
      dryRun: options.dryRun,
    },
    {
      assemble: assembleVersionedFeed,
      uploadManifest,
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
      async loadPreviousItemCount(path) {
        return (await downloadManifest(path).catch(() => null))?.itemCount ?? null;
      },
      publish: (params) => atomicPublish({ ...params, alertWebhookUrl }),
      async recordSnapshot(snapshot) {
        await db.transaction(async (tx) => {
          await tx
            .update(feedSnapshotsTable)
            .set({ isCurrent: false })
            .where(and(
              eq(feedSnapshotsTable.channel, snapshot.channel),
              eq(feedSnapshotsTable.storagePath, snapshot.storagePath),
            ));
          await tx.insert(feedSnapshotsTable).values({
            ...snapshot,
            isCurrent: true,
            generatedAt: new Date(),
          });
        });
      },
    },
  );
}