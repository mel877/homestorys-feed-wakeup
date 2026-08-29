import { db, feedSnapshotsTable, syncRunsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { loadConfig } from "../config/loader";
import { runGoogleExport } from "../exporters/google/runner";
import { runMetaExportInFreshProcess } from "../exporters/meta/fresh-process";
import { withExportLock } from "../exporters/export-lock";
import { logger as rootLogger } from "../lib/logger";
import {
  downloadManifest,
  googleFeedPath,
  googleLanguageFeedPath,
  metaFeedPath,
  metaLanguageFeedPath,
  type FeedManifest,
} from "../lib/storage";
import { runFullSync } from "../shopify";

const logger = rootLogger.child({ module: "full-sync-pipeline" });

export interface FullSyncSnapshotInfo {
  storagePath: string;
  syncRunId: string | null;
  generatedAt: string;
  fallback: boolean;
}

export interface FullSyncChannelVerification {
  ok: boolean;
  issues: string[];
  snapshots: FullSyncSnapshotInfo[];
}

export interface FullSyncSnapshotVerification {
  ok: boolean;
  expectedRunId: string;
  channels: {
    google: FullSyncChannelVerification;
    meta: FullSyncChannelVerification;
  };
}

export interface FullSyncChannelOutcome extends FullSyncChannelVerification {
  status: "ok" | "failed" | "fallback";
  error?: string;
}

export interface FullSyncPipelineResult {
  runId: string;
  status: "completed" | "degraded";
  channels: {
    google: FullSyncChannelOutcome;
    meta: FullSyncChannelOutcome;
  };
}

export interface FullSyncPipelineDependencies {
  runFullSync: () => Promise<string>;
  runGoogleExport: (options: { syncRunId: string }) => Promise<unknown>;
  runMetaExport: (options: { syncRunId: string }) => Promise<unknown>;
  withExportLock: (fn: () => Promise<void>) => Promise<unknown>;
  verifySnapshots: (runId: string) => Promise<FullSyncSnapshotVerification>;
  recordOutcome: (runId: string, result: FullSyncPipelineResult) => Promise<void>;
}

interface CurrentSnapshotRow {
  channel: string;
  storagePath: string;
  syncRunId: string | null;
  sha256: string | null;
  generatedAt: Date;
}

export interface FullSyncSnapshotVerificationDependencies {
  listCurrentSnapshots: () => Promise<CurrentSnapshotRow[]>;
  loadManifest: (storagePath: string) => Promise<FeedManifest | null>;
  expectedPaths: () => {
    google: string[];
    meta: string[];
  };
}

export interface FullSyncMarketsConfig {
  markets: Record<string, { country: string; language: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function channelOutcome(
  verification: FullSyncChannelVerification,
  exportError?: string,
): FullSyncChannelOutcome {
  const ok = verification.ok && !exportError;
  const hasFallback = verification.snapshots.some((snapshot) => snapshot.fallback);
  return {
    ...verification,
    ok,
    status: ok ? "ok" : hasFallback ? "fallback" : "failed",
    ...(exportError ? { error: exportError } : {}),
  };
}

export async function runFullSyncPipeline(
  dependencies: FullSyncPipelineDependencies = defaultDependencies,
): Promise<FullSyncPipelineResult> {
  const runId = await dependencies.runFullSync();
  let googleError: string | undefined;
  let metaError: string | undefined;
  let result: FullSyncPipelineResult | null = null;

  try {
    await dependencies.withExportLock(async () => {
      try {
        await dependencies.runGoogleExport({ syncRunId: runId });
      } catch (error) {
        googleError = errorMessage(error);
      }

      try {
        await dependencies.runMetaExport({ syncRunId: runId });
      } catch (error) {
        metaError = errorMessage(error);
      }

      const verification = await dependencies.verifySnapshots(runId);
      const google = channelOutcome(verification.channels.google, googleError);
      const meta = channelOutcome(verification.channels.meta, metaError);
      result = {
        runId,
        status: google.ok && meta.ok ? "completed" : "degraded",
        channels: { google, meta },
      };
      await dependencies.recordOutcome(runId, result);
    });
  } catch (error) {
    if (result) {
      throw error;
    }
    const message = errorMessage(error);
    googleError ??= `Feed export lock failed: ${message}`;
    metaError ??= `Feed export lock failed: ${message}`;
    const failedVerification: FullSyncSnapshotVerification = {
      ok: false,
      expectedRunId: runId,
      channels: {
        google: { ok: false, issues: [googleError], snapshots: [] },
        meta: { ok: false, issues: [metaError], snapshots: [] },
      },
    };
    const google = channelOutcome(failedVerification.channels.google, googleError);
    const meta = channelOutcome(failedVerification.channels.meta, metaError);
    result = { runId, status: "degraded", channels: { google, meta } };
    await dependencies.recordOutcome(runId, result);
  }

  if (!result) throw new Error(`Full sync pipeline ${runId} produced no outcome`);
  logger[result.status === "completed" ? "info" : "warn"](
    { runId, status: result.status, channels: result.channels },
    "Full sync pipeline finished",
  );
  return result;
}

export function expectedFullSyncSnapshotPaths(
  config: FullSyncMarketsConfig = loadConfig().markets,
): { google: string[]; meta: string[] } {
  const markets = Object.entries(config.markets);
  const publicLanguages = ["de", "fr"];
  const layerLanguages = publicLanguages.filter((language) =>
    markets.some(([, market]) => market.language === language),
  );
  const countries = [...new Set(markets.map(([, market]) => market.country))].sort();

  return {
    google: [
      ...markets.map(([marketCode, market]) => googleFeedPath(market.language, marketCode)),
      ...publicLanguages.map((language) => googleLanguageFeedPath(language)),
    ],
    meta: [
      metaFeedPath("meta-base.csv"),
      ...layerLanguages.map((language) => metaFeedPath(`meta-language-${language}.csv`)),
      ...countries.map((country) => metaFeedPath(`meta-country-${country}.csv`)),
      ...publicLanguages.map((language) => metaLanguageFeedPath(language)),
    ],
  };
}

async function verifyChannelSnapshots(
  channel: "google" | "meta",
  expectedPaths: string[],
  currentSnapshots: CurrentSnapshotRow[],
  loadManifest: (storagePath: string) => Promise<FeedManifest | null>,
  runId: string,
): Promise<FullSyncChannelVerification> {
  const issues: string[] = [];
  const snapshots: FullSyncSnapshotInfo[] = [];
  const currentByPath = new Map(
    currentSnapshots
      .filter((snapshot) => snapshot.channel === channel)
      .map((snapshot) => [snapshot.storagePath, snapshot]),
  );

  for (const storagePath of expectedPaths) {
    const snapshot = currentByPath.get(storagePath);
    if (!snapshot) {
      issues.push(`${storagePath} has no current snapshot`);
      continue;
    }

    const fallback = snapshot.syncRunId !== runId;
    snapshots.push({
      storagePath,
      syncRunId: snapshot.syncRunId,
      generatedAt: snapshot.generatedAt.toISOString(),
      fallback,
    });
    if (fallback) {
      issues.push(`${storagePath} belongs to ${snapshot.syncRunId ?? "no run"}, expected ${runId}`);
    }

    let manifest: FeedManifest | null = null;
    try {
      manifest = await loadManifest(storagePath);
    } catch (error) {
      issues.push(`${storagePath} manifest could not be read: ${errorMessage(error)}`);
      continue;
    }
    if (!manifest) {
      issues.push(`${storagePath} has no current manifest`);
      continue;
    }
    if (manifest.sourceRunId !== runId) {
      issues.push(`${storagePath} manifest belongs to ${manifest.sourceRunId ?? "no run"}, expected ${runId}`);
    }
    if (snapshot.sha256 && manifest.sha256 !== snapshot.sha256) {
      issues.push(`${storagePath} manifest checksum does not match its current snapshot`);
    }
  }

  return { ok: issues.length === 0, issues, snapshots };
}

export async function verifyFullSyncSnapshots(
  runId: string,
  dependencies: FullSyncSnapshotVerificationDependencies = defaultSnapshotVerificationDependencies,
): Promise<FullSyncSnapshotVerification> {
  const paths = dependencies.expectedPaths();
  const currentSnapshots = await dependencies.listCurrentSnapshots();
  const [google, meta] = await Promise.all([
    verifyChannelSnapshots("google", paths.google, currentSnapshots, dependencies.loadManifest, runId),
    verifyChannelSnapshots("meta", paths.meta, currentSnapshots, dependencies.loadManifest, runId),
  ]);
  return {
    ok: google.ok && meta.ok,
    expectedRunId: runId,
    channels: { google, meta },
  };
}

async function recordFullSyncPipelineOutcome(
  runId: string,
  result: FullSyncPipelineResult,
): Promise<void> {
  const pipelineMetadata = {
    fullSyncPipeline: {
      recordedAt: new Date().toISOString(),
      status: result.status,
      channels: result.channels,
    },
  };
  await db
    .update(syncRunsTable)
    .set({
      status: result.status,
      finishedAt: new Date(),
      durationMs: sql<number>`EXTRACT(EPOCH FROM (NOW() - ${syncRunsTable.startedAt})) * 1000`,
      metadata: sql`COALESCE(${syncRunsTable.metadata}, '{}'::jsonb) || ${JSON.stringify(pipelineMetadata)}::jsonb`,
    })
    .where(eq(syncRunsTable.id, runId));
}

const defaultSnapshotVerificationDependencies: FullSyncSnapshotVerificationDependencies = {
  listCurrentSnapshots: () =>
    db
      .select({
        channel: feedSnapshotsTable.channel,
        storagePath: feedSnapshotsTable.storagePath,
        syncRunId: feedSnapshotsTable.syncRunId,
        sha256: feedSnapshotsTable.sha256,
        generatedAt: feedSnapshotsTable.generatedAt,
      })
      .from(feedSnapshotsTable)
      .where(eq(feedSnapshotsTable.isCurrent, true)),
  loadManifest: downloadManifest,
  expectedPaths: expectedFullSyncSnapshotPaths,
};

const defaultDependencies: FullSyncPipelineDependencies = {
  runFullSync: () => runFullSync({ deferCompletion: true }),
  runGoogleExport,
  runMetaExport: runMetaExportInFreshProcess,
  withExportLock,
  verifySnapshots: verifyFullSyncSnapshots,
  recordOutcome: recordFullSyncPipelineOutcome,
};