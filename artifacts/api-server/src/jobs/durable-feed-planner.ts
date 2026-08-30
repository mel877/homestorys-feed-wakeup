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
  findDurableFeedPlanBySource,
  isValidatedShopifySourceRun,
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
  ): Promise<{
    status: "planned" | "existing" | "conflict";
    insertedSteps: number;
    existingRunId?: string;
  }>;
  now(): Date;
  validateSourceRun(sourceSyncRunId: string): Promise<boolean>;
  findExistingPlan(sourceSyncRunId: string): Promise<{ runId: string } | null>;
}

export interface DurableFeedPlanOptions {
  confirmation?: string;
  trigger?: "manual" | "nightly";
  sourceSyncRunId?: string;
  idempotencyKey?: string;
}

export interface DurableFeedPlanResult {
  status: "planned" | "existing" | "conflict";
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
  validateSourceRun: isValidatedShopifySourceRun,
  findExistingPlan: findDurableFeedPlanBySource,
};

export async function planDurableFeedRun(
  options: DurableFeedPlanOptions,
  dependencies: DurableFeedPlannerDependencies = defaultDependencies,
): Promise<DurableFeedPlanResult> {
  const trigger = options.trigger ?? "manual";
  const nightly = trigger === "nightly";
  if (!nightly && options.confirmation !== DURABLE_FEED_PLAN_CONFIRMATION) {
    throw new Error(`Planning requires confirmation "${DURABLE_FEED_PLAN_CONFIRMATION}"`);
  }
  if (nightly && (!options.sourceSyncRunId || options.idempotencyKey !== options.sourceSyncRunId)) {
    throw new Error("Nightly planning requires a validated source sync run id");
  }
  if (nightly) {
    const sourceSyncRunId = options.sourceSyncRunId!;
    if (!await dependencies.validateSourceRun(sourceSyncRunId)) {
      throw new Error(`Source run ${sourceSyncRunId} did not pass the Shopify completion gate`);
    }
    const existing = await dependencies.findExistingPlan(sourceSyncRunId);
    if (existing) {
      return {
        status: "existing",
        runId: existing.runId,
        productCount: 0,
        buildSteps: 0,
        finalizeSteps: 0,
        totalSteps: 0,
      };
    }
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
      trigger,
      version,
      productCount: productIds.length,
      channels: ["google", "meta"],
      ...(options.sourceSyncRunId
        ? {
            sourceSyncRunId: options.sourceSyncRunId,
            idempotencyKey: options.idempotencyKey,
          }
        : {}),
    },
    specs,
    sourceSyncRunId: options.sourceSyncRunId,
  });

  if (persisted.status === "existing") {
    return {
      status: "existing",
      runId: persisted.existingRunId,
      productCount: productIds.length,
      buildSteps: builds.length,
      finalizeSteps: specs.length - builds.length,
      totalSteps: specs.length,
    };
  }
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