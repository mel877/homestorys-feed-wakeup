import { describe, expect, it } from "vitest";
import {
  createProductBatches,
  createGoogleFeedBatchSpecs,
  createMetaFeedBatchSpecs,
  createFeedFinalizationSpecs,
  feedFileIsComplete,
  type FeedExportBatchRecord,
} from "../src/exporters/durable-feed-batches";

describe("durable feed batches", () => {
  it("sorts and chunks product ids deterministically", () => {
    expect(createProductBatches(["p-3", "p-1", "p-2", "p-1"], 2)).toEqual([
      { batchIndex: 0, productIds: ["p-1", "p-2"] },
      { batchIndex: 1, productIds: ["p-3"] },
    ]);
  });

  it("creates Google market and language file steps with stable source metadata", () => {
    const specs = createGoogleFeedBatchSpecs({
      syncRunId: "run-1",
      version: "2026-08-29T16-00-00",
      productIds: ["p-2", "p-1"],
      markets: {
        BE_FR: { language: "fr", country: "BE" },
        BE_DE: { language: "de", country: "BE" },
      },
      languages: ["fr"],
      batchSize: 1,
      sourceFingerprints: { "p-1": "f1", "p-2": "f2" },
    });

    expect(specs).toHaveLength(6);
    expect(specs.map((spec) => [spec.marketCode, spec.language, spec.batchIndex])).toEqual([
      ["BE_FR", "fr", 0],
      ["BE_FR", "fr", 1],
      ["BE_DE", "de", 0],
      ["BE_DE", "de", 1],
      ["LANG_FR", "fr", 0],
      ["LANG_FR", "fr", 1],
    ]);
    expect(specs[0]).toMatchObject({
      syncRunId: "run-1",
      channel: "google",
      stage: "build",
      checkpoint: {
        fileKey: "google-market-BE_FR",
        version: "2026-08-29T16-00-00",
        productIds: ["p-1"],
        sourceFingerprints: { "p-1": "f1" },
      },
    });
  });

  it("creates Meta shared-layer steps with the complete contribution set", () => {
    const specs = createMetaFeedBatchSpecs({
      syncRunId: "run-1",
      version: "v1",
      productIds: ["p-1", "p-2"],
      markets: {
        BE_FR: { language: "fr", country: "BE" },
        BE_DE: { language: "de", country: "BE" },
      },
      batchSize: 2,
      sourceFingerprints: { "p-1": "f1", "p-2": "f2" },
    });

    expect(specs.map((spec) => spec.checkpoint)).toEqual([
      {
        fileKey: "meta-base",
        version: "v1",
        productIds: ["p-1", "p-2"],
        contributingMarkets: ["BE_FR", "BE_DE"],
        sourceMarkets: ["BE_DE", "BE_FR"],
        sourceFingerprints: { "p-1": "f1", "p-2": "f2" },
      },
      {
        fileKey: "meta-language-fr",
        version: "v1",
        productIds: ["p-1", "p-2"],
        contributingMarkets: ["BE_FR"],
        sourceMarkets: ["BE_DE", "BE_FR"],
        sourceFingerprints: { "p-1": "f1", "p-2": "f2" },
      },
      {
        fileKey: "meta-language-de",
        version: "v1",
        productIds: ["p-1", "p-2"],
        contributingMarkets: ["BE_DE"],
        sourceMarkets: ["BE_DE", "BE_FR"],
        sourceFingerprints: { "p-1": "f1", "p-2": "f2" },
      },
      {
        fileKey: "meta-country-BE",
        version: "v1",
        productIds: ["p-1", "p-2"],
        contributingMarkets: ["BE_FR", "BE_DE"],
        sourceMarkets: ["BE_DE", "BE_FR"],
        sourceFingerprints: { "p-1": "f1", "p-2": "f2" },
      },
    ]);
  });

  it("does not open the finalization barrier until every required batch is complete", () => {
    const required = ["step-a", "step-b"];
    const complete = (id: string): FeedExportBatchRecord => ({
      id,
      status: "completed",
      artifactPath: `parts/${id}.jsonl`,
      itemCount: 1,
      sha256: `hash-${id}`,
    });

    expect(feedFileIsComplete(required, [complete("step-a")])).toBe(false);
    expect(feedFileIsComplete(required, [
      complete("step-a"),
      { ...complete("step-b"), status: "running" },
    ])).toBe(false);
    expect(feedFileIsComplete(required, [
      complete("step-a"),
      complete("step-b"),
    ])).toBe(true);
  });

  it("creates one finalization barrier with the exhaustive batch indexes per file", () => {
    const builds = createGoogleFeedBatchSpecs({
      syncRunId: "run-1",
      version: "v1",
      productIds: ["p-1", "p-2", "p-3"],
      markets: { CH_DE: { language: "de", country: "CH" } },
      languages: [],
      batchSize: 2,
      sourceFingerprints: { "p-1": "f1", "p-2": "f2", "p-3": "f3" },
    });

    expect(createFeedFinalizationSpecs(builds)).toEqual([
      {
        syncRunId: "run-1",
        channel: "google",
        stage: "finalize",
        marketCode: "CH_DE",
        language: "de",
        batchIndex: 0,
        checkpoint: {
          fileKey: "google-market-CH_DE",
          version: "v1",
          requiredBatchIndexes: [0, 1],
          contributingMarkets: ["CH_DE"],
        },
      },
    ]);
  });
});