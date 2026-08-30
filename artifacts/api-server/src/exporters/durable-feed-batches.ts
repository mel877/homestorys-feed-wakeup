import type { FeedExportStepSpec } from "../jobs/feed-export-step-repository";

export const DEFAULT_FEED_PRODUCT_BATCH_SIZE = 250;

export interface ProductBatch {
  batchIndex: number;
  productIds: string[];
}

export interface MarketDescriptor {
  language: string;
  country: string;
}

export interface FeedExportBatchRecord {
  id: string;
  status: string;
  artifactPath: string | null;
  itemCount: number | null;
  sha256: string | null;
}

interface SharedPlanOptions {
  syncRunId: string;
  version: string;
  productIds: string[];
  batchSize?: number;
  sourceFingerprints: Record<string, string>;
}

interface BatchCheckpoint extends Record<string, unknown> {
  fileKey: string;
  version: string;
  productIds: string[];
  contributingMarkets?: string[];
  sourceMarkets: string[];
  sourceFingerprints: Record<string, string>;
}

export function createProductBatches(
  productIds: string[],
  batchSize = DEFAULT_FEED_PRODUCT_BATCH_SIZE,
): ProductBatch[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("Feed product batch size must be a positive integer");
  }
  const stableIds = [...new Set(productIds)].sort((a, b) => a.localeCompare(b));
  const batches: ProductBatch[] = [];
  for (let start = 0; start < stableIds.length; start += batchSize) {
    batches.push({
      batchIndex: batches.length,
      productIds: stableIds.slice(start, start + batchSize),
    });
  }
  return batches;
}

function buildSpecs(
  options: SharedPlanOptions,
  file: {
    channel: "google" | "meta";
    fileKey: string;
    marketCode: string;
    language: string;
    contributingMarkets: string[];
    sourceMarkets: string[];
  },
): FeedExportStepSpec[] {
  return createProductBatches(options.productIds, options.batchSize).map((batch) => {
    const checkpoint: BatchCheckpoint = {
      fileKey: file.fileKey,
      version: options.version,
      productIds: batch.productIds,
      sourceMarkets: file.sourceMarkets,
      sourceFingerprints: Object.fromEntries(
        batch.productIds.map((id) => {
          const fingerprint = options.sourceFingerprints[id];
          if (!fingerprint) throw new Error(`Missing source fingerprint for product ${id}`);
          return [id, fingerprint];
        }),
      ),
      ...(file.contributingMarkets.length > 0
        ? { contributingMarkets: file.contributingMarkets }
        : {}),
    };
    return {
      syncRunId: options.syncRunId,
      channel: file.channel,
      stage: "build",
      marketCode: file.marketCode,
      language: file.language,
      batchIndex: batch.batchIndex,
      cursor: {
        firstProductId: batch.productIds[0] ?? null,
        lastProductId: batch.productIds.at(-1) ?? null,
      },
      checkpoint,
    };
  });
}

export function createGoogleFeedBatchSpecs(
  options: SharedPlanOptions & {
    markets: Record<string, MarketDescriptor>;
    languages: string[];
  },
): FeedExportStepSpec[] {
  const specs: FeedExportStepSpec[] = [];
  const sourceMarkets = Object.keys(options.markets).sort();
  for (const [marketCode, market] of Object.entries(options.markets)) {
    specs.push(...buildSpecs(options, {
      channel: "google",
      fileKey: `google-market-${marketCode}`,
      marketCode,
      language: market.language,
      contributingMarkets: [marketCode],
      sourceMarkets,
    }));
  }
  for (const language of options.languages) {
    const contributingMarkets = Object.entries(options.markets)
      .filter(([, market]) => market.language === language)
      .map(([marketCode]) => marketCode);
    if (contributingMarkets.length === 0) continue;
    specs.push(...buildSpecs(options, {
      channel: "google",
      fileKey: `google-language-${language}`,
      marketCode: `LANG_${language.toUpperCase()}`,
      language,
      contributingMarkets,
      sourceMarkets,
    }));
  }
  return specs;
}

export function createMetaFeedBatchSpecs(
  options: SharedPlanOptions & {
    markets: Record<string, MarketDescriptor>;
  },
): FeedExportStepSpec[] {
  const specs: FeedExportStepSpec[] = [];
  const marketEntries = Object.entries(options.markets);
  const allMarkets = marketEntries.map(([marketCode]) => marketCode);
  const sourceMarkets = [...allMarkets].sort();

  specs.push(...buildSpecs(options, {
    channel: "meta",
    fileKey: "meta-base",
    marketCode: "BASE",
    language: "",
    contributingMarkets: allMarkets,
    sourceMarkets,
  }));

  const languages = [...new Set(marketEntries.map(([, market]) => market.language))];
  for (const language of languages) {
    const contributingMarkets = marketEntries
      .filter(([, market]) => market.language === language)
      .map(([marketCode]) => marketCode);
    specs.push(...buildSpecs(options, {
      channel: "meta",
      fileKey: `meta-language-${language}`,
      marketCode: `LANG_${language.toUpperCase()}`,
      language,
      contributingMarkets,
      sourceMarkets,
    }));
  }

  const countries = [...new Set(marketEntries.map(([, market]) => market.country))];
  for (const country of countries) {
    const contributingMarkets = marketEntries
      .filter(([, market]) => market.country === country)
      .map(([marketCode]) => marketCode);
    specs.push(...buildSpecs(options, {
      channel: "meta",
      fileKey: `meta-country-${country}`,
      marketCode: country,
      language: "",
      contributingMarkets,
      sourceMarkets,
    }));
  }
  return specs;
}

export function createFeedFinalizationSpecs(
  buildSpecs: FeedExportStepSpec[],
): FeedExportStepSpec[] {
  const groups = new Map<string, FeedExportStepSpec[]>();
  for (const spec of buildSpecs) {
    if (spec.stage !== "build" || !spec.checkpoint) continue;
    const checkpoint = spec.checkpoint as BatchCheckpoint;
    if (typeof checkpoint.fileKey !== "string") continue;
    const group = groups.get(checkpoint.fileKey) ?? [];
    group.push(spec);
    groups.set(checkpoint.fileKey, group);
  }

  return [...groups.entries()].map(([fileKey, specs]) => {
    const first = specs[0]!;
    const checkpoint = first.checkpoint as BatchCheckpoint;
    return {
      syncRunId: first.syncRunId,
      channel: first.channel,
      stage: "finalize",
      marketCode: first.marketCode,
      language: first.language,
      batchIndex: 0,
      checkpoint: {
        fileKey,
        version: checkpoint.version,
        requiredBatchIndexes: [...new Set(specs.map((spec) => spec.batchIndex))]
          .sort((a, b) => a - b),
        contributingMarkets: checkpoint.contributingMarkets ?? [],
      },
    };
  });
}

export function createMetaMarketFinalizationSpecs(options: {
  syncRunId: string;
  version: string;
  markets: Record<string, MarketDescriptor>;
}): FeedExportStepSpec[] {
  const supported = new Set([
    "FR", "BE_FR", "BE_DE", "DE", "AT", "LU_DE", "CH_FR", "CH_DE",
  ]);
  return Object.entries(options.markets)
    .filter(([marketCode]) => supported.has(marketCode))
    .map(([marketCode, market]) => ({
      syncRunId: options.syncRunId,
      channel: "meta",
      stage: "finalize",
      marketCode,
      language: market.language,
      batchIndex: 0,
      checkpoint: {
        fileKey: `meta-market-${marketCode}`,
        version: options.version,
        requiredBatchIndexes: [],
        contributingMarkets: [marketCode],
        requiredFinalizerFileKeys: [
          "meta-base",
          `meta-language-${market.language}`,
          `meta-country-${market.country}`,
        ],
      },
    }));
}

export function feedFileIsComplete(
  requiredStepIds: string[],
  steps: FeedExportBatchRecord[],
): boolean {
  if (requiredStepIds.length === 0) return false;
  const byId = new Map(steps.map((step) => [step.id, step]));
  return requiredStepIds.every((id) => {
    const step = byId.get(id);
    return Boolean(
      step &&
      step.status === "completed" &&
      step.artifactPath &&
      step.itemCount !== null &&
      step.sha256,
    );
  });
}