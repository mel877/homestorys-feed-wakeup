import type { CanonicalProduct } from "../canonical/types";
import type { AppConfig } from "../config/schemas";
import {
  googleFeedPath,
  googleLanguageFeedPath,
  metaFeedPath,
  uploadImmutableFeedFile,
  versionedPath,
} from "../lib/storage";
import { completeFeedExportStep } from "../jobs/feed-export-step-repository";
import { getOrCreateFrozenSourceBatch } from "../jobs/feed-export-source-repository";
import { readAllCanonicals, type ReadOptions } from "./canonical-reader";
import { mapToGoogleRow, type GoogleFeedRow } from "./google/mapper";
import {
  mapToMeta,
  type MetaMapped,
} from "./meta/mapper";
import {
  deterministicFeedPartPath,
  serializeFeedPart,
} from "./durable-feed-parts";

export interface DurableFeedBuildCheckpoint extends Record<string, unknown> {
  fileKey: string;
  version: string;
  productIds: string[];
  contributingMarkets: string[];
  sourceMarkets: string[];
  sourceFingerprints: Record<string, string>;
}

export interface DurableFeedBuildStep {
  id: string;
  syncRunId: string;
  channel: "google" | "meta";
  stage: "build";
  marketCode: string;
  language: string;
  batchIndex: number;
  checkpoint: unknown;
}

type CanonicalReader = (
  config: AppConfig,
  options: ReadOptions,
 ) => Promise<{ canonicals: CanonicalProduct[] }>;

interface CommonBuildDependencies {
  readCanonicals: CanonicalReader;
  getFrozenCanonicals(
    input: {
      syncRunId: string;
      channel: "google" | "meta";
      batchIndex: number;
      productIds: string[];
      sourceMarkets: string[];
    },
    createCanonicals: () => Promise<CanonicalProduct[]>,
  ): Promise<CanonicalProduct[]>;
  computeSourceFingerprints(productIds: string[]): Promise<Record<string, string>>;
  verifySourceFingerprints(expected: Record<string, string>): Promise<void>;
  uploadPart: (path: string, content: string) => Promise<string>;
  completeStep: typeof completeFeedExportStep;
}

export interface GoogleBuildDependencies extends CommonBuildDependencies {
  mapGoogle: (canonical: CanonicalProduct, config: AppConfig, options?: {
    qualifyIdWithMarket?: boolean;
  }) => GoogleFeedRow | null;
}

export interface MetaBuildDependencies extends CommonBuildDependencies {
  mapMeta: (canonical: CanonicalProduct, config: AppConfig) => MetaMapped | null;
}

export interface DurableFeedBuildResult {
  artifactPath: string;
  itemCount: number;
  sha256: string;
}

export async function executeGoogleFeedBuildStep(
  step: DurableFeedBuildStep,
  workerId: string,
  config: AppConfig,
  dependencies: GoogleBuildDependencies = defaultGoogleDependencies,
): Promise<DurableFeedBuildResult> {
  if (step.channel !== "google" || step.stage !== "build") {
    throw new Error("Expected a Google build step");
  }
  const checkpoint = parseCheckpoint(step.checkpoint);
  const isLanguageFile = checkpoint.fileKey.startsWith("google-language-");
  const currentPath = isLanguageFile
    ? googleLanguageFeedPath(step.language)
    : googleFeedPath(step.language, step.marketCode);
  const artifactPath = deterministicFeedPartPath(
    versionedPath(currentPath, checkpoint.version),
    step.batchIndex,
  );
  const rows: GoogleFeedRow[] = [];

  const canonicals = await frozenCanonicals(step, checkpoint, config, dependencies);
  for (const canonical of canonicals) {
    if (
      canonical.exclusionReasons.length === 0 &&
      checkpoint.contributingMarkets.includes(canonical.market)
    ) {
      const row = dependencies.mapGoogle(
        canonical,
        config,
        isLanguageFile ? { qualifyIdWithMarket: true } : undefined,
      );
      if (row) rows.push(row);
    }
  }

  const content = serializeFeedPart(rows as unknown as Array<Record<string, unknown>>);
  const sha256 = await dependencies.uploadPart(artifactPath, content);
  await persistCompletion(step, workerId, checkpoint, artifactPath, rows.length, sha256, dependencies);
  return { artifactPath, itemCount: rows.length, sha256 };
}

export async function executeMetaFeedBuildStep(
  step: DurableFeedBuildStep,
  workerId: string,
  config: AppConfig,
  dependencies: MetaBuildDependencies = defaultMetaDependencies,
): Promise<DurableFeedBuildResult> {
  if (step.channel !== "meta" || step.stage !== "build") {
    throw new Error("Expected a Meta build step");
  }
  const checkpoint = parseCheckpoint(step.checkpoint);
  const currentPath = metaCurrentPath(checkpoint.fileKey);
  const artifactPath = deterministicFeedPartPath(
    versionedPath(currentPath, checkpoint.version),
    step.batchIndex,
  );
  const rows = new Map<string, Record<string, unknown>>();

  const canonicals = await frozenCanonicals(step, checkpoint, config, dependencies);
  for (const canonical of canonicals) {
    if (
      canonical.exclusionReasons.length === 0 &&
      checkpoint.contributingMarkets.includes(canonical.market)
    ) {
      const mapped = dependencies.mapMeta(canonical, config);
      if (!mapped) continue;
      const row = selectMetaLayer(checkpoint.fileKey, mapped);
      rows.set(mapped.id, row);
    }
  }

  const values = [...rows.values()];
  const content = serializeFeedPart(values);
  const sha256 = await dependencies.uploadPart(artifactPath, content);
  await persistCompletion(step, workerId, checkpoint, artifactPath, values.length, sha256, dependencies);
  return { artifactPath, itemCount: values.length, sha256 };
}

function parseCheckpoint(value: unknown): DurableFeedBuildCheckpoint {
  if (!value || typeof value !== "object") {
    throw new Error("Feed build step has no checkpoint");
  }
  const checkpoint = value as Partial<DurableFeedBuildCheckpoint>;
  if (
    typeof checkpoint.fileKey !== "string" ||
    typeof checkpoint.version !== "string" ||
    !Array.isArray(checkpoint.productIds) ||
    !checkpoint.productIds.every((id) => typeof id === "string") ||
    !Array.isArray(checkpoint.contributingMarkets) ||
    checkpoint.contributingMarkets.length === 0 ||
    !checkpoint.contributingMarkets.every((market) => typeof market === "string") ||
    !Array.isArray(checkpoint.sourceMarkets) ||
    checkpoint.sourceMarkets.length === 0 ||
    !checkpoint.sourceMarkets.every((market) => typeof market === "string")
    || !checkpoint.sourceFingerprints
    || typeof checkpoint.sourceFingerprints !== "object"
  ) {
    throw new Error("Feed build step checkpoint is invalid");
  }
  return checkpoint as DurableFeedBuildCheckpoint;
}

async function frozenCanonicals(
  step: DurableFeedBuildStep,
  checkpoint: DurableFeedBuildCheckpoint,
  config: AppConfig,
  dependencies: CommonBuildDependencies,
): Promise<CanonicalProduct[]> {
  return dependencies.getFrozenCanonicals(
    {
      syncRunId: step.syncRunId,
      channel: step.channel,
      batchIndex: step.batchIndex,
      productIds: checkpoint.productIds,
      sourceMarkets: checkpoint.sourceMarkets,
    },
    async () => {
      const before = await dependencies.computeSourceFingerprints(checkpoint.productIds);
      const canonicals = (await dependencies.readCanonicals(config, {
        productIds: checkpoint.productIds,
        markets: checkpoint.sourceMarkets,
        channel: step.channel,
        persistFeedItems: false,
      })).canonicals;
      await dependencies.verifySourceFingerprints(before);
      return canonicals;
    },
  );
}

function metaCurrentPath(fileKey: string): string {
  if (fileKey === "meta-base") return metaFeedPath("meta-base.csv");
  if (fileKey.startsWith("meta-language-")) {
    return metaFeedPath(`${fileKey}.csv`);
  }
  if (fileKey.startsWith("meta-country-")) {
    return metaFeedPath(`${fileKey}.csv`);
  }
  throw new Error(`Unsupported Meta file key: ${fileKey}`);
}

function selectMetaLayer(
  fileKey: string,
  mapped: MetaMapped,
): Record<string, unknown> {
  if (fileKey === "meta-base") {
    return mapped.base as unknown as Record<string, unknown>;
  }
  if (fileKey.startsWith("meta-language-")) {
    return mapped.language_row as unknown as Record<string, unknown>;
  }
  if (fileKey.startsWith("meta-country-")) {
    return mapped.country_row as unknown as Record<string, unknown>;
  }
  throw new Error(`Unsupported Meta file key: ${fileKey}`);
}

async function persistCompletion(
  step: DurableFeedBuildStep,
  workerId: string,
  checkpoint: DurableFeedBuildCheckpoint,
  artifactPath: string,
  itemCount: number,
  sha256: string,
  dependencies: CommonBuildDependencies,
): Promise<void> {
  const completed = await dependencies.completeStep(step.id, workerId, {
    artifactPath,
    itemCount,
    sha256,
    checkpoint,
  });
  if (!completed) {
    throw new Error(`Feed build step ${step.id} lost its lease before completion`);
  }
}

const commonDependencies: CommonBuildDependencies = {
  readCanonicals: readAllCanonicals,
  async getFrozenCanonicals(input, createCanonicals) {
    return (await getOrCreateFrozenSourceBatch(input, createCanonicals)).canonicals;
  },
  computeSourceFingerprints: async (productIds) => {
    const { computeProductSourceFingerprints } = await import(
      "../jobs/feed-export-source-repository"
    );
    return computeProductSourceFingerprints(productIds);
  },
  verifySourceFingerprints: async (expected) => {
    const { assertProductSourceFingerprints } = await import(
      "../jobs/feed-export-source-repository"
    );
    await assertProductSourceFingerprints(expected);
  },
  uploadPart: (path, content) => uploadImmutableFeedFile(path, content, "application/json"),
  completeStep: completeFeedExportStep,
};

const defaultGoogleDependencies: GoogleBuildDependencies = {
  ...commonDependencies,
  mapGoogle: mapToGoogleRow,
};

const defaultMetaDependencies: MetaBuildDependencies = {
  ...commonDependencies,
  mapMeta: mapToMeta,
};