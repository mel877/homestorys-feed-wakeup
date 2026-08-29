import { randomUUID } from "node:crypto";
import { loadConfig, type AppConfig } from "../config";
import {
  createGoogleFeedBatchSpecs,
  createMetaFeedBatchSpecs,
  createFeedFinalizationSpecs,
} from "../exporters/durable-feed-batches";
import {
  computeProductSourceFingerprints,
} from "./feed-export-source-repository";
import {
  persistDurableFeedRunPlan,
  type DurableFeedRunPlanInput,
} from "./feed-export-step-repository";
import { formatVersionTs } from "../lib/storage";
import { productsTable, db } from "@workspace/db";
import { asc, eq } from "drizzle-orm";

export const DURABLE_FEED_PLAN_CONFIRMATION = "PLAN_DURABLE_FEEDS";

export interface DurableFeedPlannerDependencies {
  listActiveProductIds(): Promise<string[]>;
  computeFingerprints(productIds: string[]): Promise<Record<string, string>>;
  getConfig(): AppConfig;
  persistPlan(
    input: DurableFeedRunPlanInput,
  ): Promise<{ status: "planned" | "conflict"; insertedSteps: number }>;
  now(): Date;
}

export interface DurableFeedPlanOptions {
  confirmation: string;
}

export interface DurableFeedPlanResult {
  status: "planned" | "conflict";
  runId?: string;
  version?: string;
  productCount: number;
  buildSteps: number;
  finalizeSteps: number;
  totalSteps: number;
}

const defaultDependencies: DurableFeedPlannerDependencies = {
  listActiveProductIds: async () => {
    const rows = await db
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(eq(productsTable.status, "active"))
      .orderBy(asc(productsTable.id));
    return rows.map((row) => row.id);
  },
  computeFingerprints: computeProductSourceFingerprints,
  getConfig: loadConfig,
  persistPlan: persistDurableFeedRunPlan,
  now: () => new Date(),
};

export async function planDurableFeedRun(
  options: DurableFeedPlanOptions,
  dependencies: DurableFeedPlannerDependencies = defaultDependencies,
): Promise<DurableFeedPlanResult> {
  if (options.confirmation !== DURABLE_FEED_PLAN_CONFIRMATION) {
    throw new Error(`Planning requires confirmation "${DURABLE_FEED_PLAN_CONFIRMATION}"`);
  }

  const productIds = await dependencies.listActiveProductIds();
  if (productIds.length === 0) {
    throw new Error("No active products available for durable feed planning");
  }
  const sourceFingerprints = await dependencies.computeFingerprints(productIds);
  for (const productId of productIds) {
    if (!sourceFingerprints[productId]) {
      throw new Error(`Missing source fingerprint for product ${productId}`);
    }
  }

  const runId = randomUUID();
  const version = formatVersionTs(dependencies.now());
  const config = dependencies.getConfig();
  const shared = {
    syncRunId: runId,
    version,
    productIds,
    sourceFingerprints,
  };
  const googleBuilds = createGoogleFeedBatchSpecs({
    ...shared,
    markets: config.markets.markets,
    languages: config.languages.languages.map((language) => language.code),
  });
  const metaBuilds = createMetaFeedBatchSpecs({
    ...shared,
    markets: config.markets.markets,
  });
  const builds = [...googleBuilds, ...metaBuilds];
  const specs = [...builds, ...createFeedFinalizationSpecs(builds)];
  const persisted = await dependencies.persistPlan({
    runId,
    metadata: {
      architecture: "durable-feed",
      trigger: "manual",
      version,
      productCount: productIds.length,
      channels: ["google", "meta"],
    },
    specs,
  });

  if (persisted.status === "conflict") {
    return {
      status: "conflict",
      productCount: 0,
      buildSteps: 0,
      finalizeSteps: 0,
      totalSteps: 0,
    };
  }

  return {
    status: "planned",
    runId,
    version,
    productCount: productIds.length,
    buildSteps: builds.length,
    finalizeSteps: specs.length - builds.length,
    totalSteps: specs.length,
  };
}