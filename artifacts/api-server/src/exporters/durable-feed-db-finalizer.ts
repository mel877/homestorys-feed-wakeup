import type { FeedExportStep } from "@workspace/db";
import {
  listFeedExportBuildStepsForFile,
} from "../jobs/feed-export-step-repository";
import { computeFeedFileSha256 } from "../lib/storage";
import {
  deterministicFeedPartPath,
  type CompletedFeedPart,
} from "./durable-feed-parts";

export interface VerifiedFeedPartsInput {
  syncRunId: string;
  channel: "google" | "meta";
  marketCode: string;
  language: string;
  fileKey: string;
  versionedPath: string;
  requiredBatchIndexes: number[];
}

interface VerifiedFeedStep {
  id: string;
  batchIndex: number;
  status: string;
  artifactPath: string | null;
  sha256: string | null;
  itemCount: number | null;
}

export interface VerifiedFeedPartsDependencies {
  loadSteps(input: {
    syncRunId: string;
    channel: "google" | "meta";
    marketCode: string;
    language: string;
    fileKey: string;
  }): Promise<VerifiedFeedStep[]>;
  computeSha256(path: string): Promise<string | null>;
}

export async function loadVerifiedFeedParts(
  input: VerifiedFeedPartsInput,
  dependencies: VerifiedFeedPartsDependencies = defaultDependencies,
): Promise<CompletedFeedPart[]> {
  const required = [...input.requiredBatchIndexes].sort((a, b) => a - b);
  if (
    required.length === 0 ||
    new Set(required).size !== required.length ||
    required.some((index) => !Number.isInteger(index) || index < 0)
  ) {
    throw new Error("Finalization has an invalid required batch index set");
  }
  const steps = await dependencies.loadSteps(input);
  const byIndex = new Map<number, VerifiedFeedStep>();
  for (const step of steps) {
    if (byIndex.has(step.batchIndex)) {
      throw new Error(`Finalization found duplicate batch index ${step.batchIndex}`);
    }
    byIndex.set(step.batchIndex, step);
  }
  const actual = [...byIndex.keys()].sort((a, b) => a - b);
  const missing = required.filter((index) => !byIndex.has(index));
  const unexpected = actual.filter((index) => !required.includes(index));
  if (missing.length > 0) {
    throw new Error(`Finalization is missing required batches: ${missing.join(",")}`);
  }
  if (unexpected.length > 0) {
    throw new Error(`Finalization found unexpected batches: ${unexpected.join(",")}`);
  }

  const parts: CompletedFeedPart[] = [];
  for (const batchIndex of required) {
    const step = byIndex.get(batchIndex)!;
    if (
      step.status !== "completed" ||
      !step.artifactPath ||
      !step.sha256 ||
      step.itemCount === null
    ) {
      throw new Error(`Finalization batch ${batchIndex} is incomplete`);
    }
    const expectedPath = deterministicFeedPartPath(input.versionedPath, batchIndex);
    if (step.artifactPath !== expectedPath) {
      throw new Error(`Finalization batch ${batchIndex} has an incoherent artifact path`);
    }
    const actualSha256 = await dependencies.computeSha256(step.artifactPath);
    if (!actualSha256) {
      throw new Error(`Finalization part is missing from storage: ${step.artifactPath}`);
    }
    if (actualSha256 !== step.sha256) {
      throw new Error(`Finalization checksum mismatch for batch ${batchIndex}`);
    }
    parts.push({
      batchIndex,
      artifactPath: step.artifactPath,
      status: step.status,
    });
  }
  return parts;
}

const defaultDependencies: VerifiedFeedPartsDependencies = {
  loadSteps: listFeedExportBuildStepsForFile as (
    input: Parameters<typeof listFeedExportBuildStepsForFile>[0],
  ) => Promise<FeedExportStep[]>,
  computeSha256: computeFeedFileSha256,
};