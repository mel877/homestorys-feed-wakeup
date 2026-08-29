import { describe, expect, it, vi } from "vitest";
import {
  executeGoogleFeedBuildStep,
  executeMetaFeedBuildStep,
  type DurableFeedBuildStep,
} from "../src/exporters/durable-feed-builders";

const step = (channel: "google" | "meta", fileKey: string): DurableFeedBuildStep => ({
  id: "step-1",
  syncRunId: "run-1",
  channel,
  stage: "build",
  marketCode: channel === "google" ? "BE_FR" : "BE",
  language: channel === "google" ? "fr" : "",
  batchIndex: 3,
  checkpoint: {
    fileKey,
    version: "v1",
    productIds: ["product-1"],
    contributingMarkets: ["BE_FR"],
    sourceMarkets: ["BE_FR", "CH_FR"],
    sourceFingerprints: { "product-1": "fingerprint-1" },
  },
});

describe("durable feed builders", () => {
  it("writes and completes a deterministic Google part", async () => {
    const uploadPart = vi.fn().mockResolvedValue("sha-google");
    const completeStep = vi.fn().mockResolvedValue(true);
    const result = await executeGoogleFeedBuildStep(
      step("google", "google-market-BE_FR"),
      "worker-1",
      {} as never,
      {
        readCanonicals: async (_config, options) => {
          expect(options).toMatchObject({
            productIds: ["product-1"],
            markets: ["BE_FR", "CH_FR"],
            channel: "google",
          });
          return { canonicals: [] };
        },
        getFrozenCanonicals: async (_input, _create) => [{
          id: "canonical-1",
          exclusionReasons: [],
          market: "BE_FR",
        } as never],
        verifySourceFingerprints: vi.fn(),
        mapGoogle: () => ({ id: "offer-1", title: "Chair" } as never),
        uploadPart,
        completeStep,
      },
    );

    expect(result.artifactPath).toBe(
      "feeds/google/versions/v1/google-fr-BE_FR.tsv.parts/000003.jsonl",
    );
    expect(uploadPart).toHaveBeenCalledWith(
      result.artifactPath,
      '{"id":"offer-1","title":"Chair"}\n',
    );
    expect(completeStep).toHaveBeenCalledWith("step-1", "worker-1", {
      artifactPath: result.artifactPath,
      itemCount: 1,
      sha256: "sha-google",
      checkpoint: step("google", "google-market-BE_FR").checkpoint,
    });
  });

  it("selects only the requested Meta layer", async () => {
    const uploadPart = vi.fn().mockResolvedValue("sha-meta");
    const completeStep = vi.fn().mockResolvedValue(true);
    await executeMetaFeedBuildStep(
      step("meta", "meta-country-BE"),
      "worker-1",
      {} as never,
      {
        readCanonicals: async () => ({ canonicals: [] }),
        getFrozenCanonicals: async () => [{
          id: "canonical-1",
          exclusionReasons: [],
          market: "BE_FR",
        } as never],
        verifySourceFingerprints: vi.fn(),
        mapMeta: () => ({
          id: "offer-1",
          language: "fr",
          country: "BE",
          base: { id: "offer-1", brand: "Brand" },
          language_row: { id: "offer-1", title: "Chair" },
          country_row: { id: "offer-1", price: "10.00 EUR" },
        } as never),
        uploadPart,
        completeStep,
      },
    );

    expect(uploadPart).toHaveBeenCalledWith(
      "feeds/meta/versions/v1/meta-country-BE.csv.parts/000003.jsonl",
      '{"id":"offer-1","price":"10.00 EUR"}\n',
    );
  });

  it("reuses the frozen canonical source after a product changes or the worker restarts", async () => {
    let currentTitle = "Frozen title";
    let durableSource: Array<Record<string, unknown>> | null = null;
    const readCanonicals = vi.fn(async () => ({
      canonicals: [{
        id: "canonical-1",
        exclusionReasons: [],
        market: "BE_FR",
        title: currentTitle,
      } as never],
    }));
    const durableStore = async (
      _input: unknown,
      create: () => Promise<Array<Record<string, unknown>>>,
    ) => {
      if (!durableSource) durableSource = await create();
      return durableSource as never;
    };
    const uploaded: string[] = [];
    const dependencies = {
      readCanonicals,
      getFrozenCanonicals: durableStore,
      verifySourceFingerprints: vi.fn(),
      mapGoogle: (canonical: { title: string }) => ({
        id: "offer-1",
        title: canonical.title,
      }) as never,
      uploadPart: async (_path: string, content: string) => {
        uploaded.push(content);
        return "stable-sha";
      },
      completeStep: vi.fn().mockResolvedValue(true),
    };

    await executeGoogleFeedBuildStep(
      step("google", "google-market-BE_FR"),
      "worker-before-restart",
      {} as never,
      dependencies as never,
    );
    currentTitle = "Shopify changed title";
    await executeGoogleFeedBuildStep(
      step("google", "google-market-BE_FR"),
      "worker-after-restart",
      {} as never,
      { ...dependencies } as never,
    );

    expect(readCanonicals).toHaveBeenCalledTimes(1);
    expect(dependencies.verifySourceFingerprints).toHaveBeenCalledTimes(2);
    expect(uploaded).toEqual([
      '{"id":"offer-1","title":"Frozen title"}\n',
      '{"id":"offer-1","title":"Frozen title"}\n',
    ]);
  });

  it("blocks a later batch when its planned source fingerprint changed", async () => {
    const changedStep = {
      ...step("google", "google-market-BE_FR"),
      batchIndex: 4,
      checkpoint: {
        ...step("google", "google-market-BE_FR").checkpoint as Record<string, unknown>,
        productIds: ["product-2"],
        sourceFingerprints: { "product-2": "planned-fingerprint" },
      },
    };
    const uploadPart = vi.fn();
    await expect(executeGoogleFeedBuildStep(
      changedStep,
      "worker-1",
      {} as never,
      {
        readCanonicals: vi.fn(),
        getFrozenCanonicals: async (_input, create) => create(),
        verifySourceFingerprints: async () => {
          throw new Error("Source changed during feed export for product product-2");
        },
        mapGoogle: vi.fn(),
        uploadPart,
        completeStep: vi.fn(),
      },
    )).rejects.toThrow("Source changed during feed export");
    expect(uploadPart).not.toHaveBeenCalled();
  });

  it("blocks when Shopify changes the source during canonical capture", async () => {
    let verification = 0;
    const uploadPart = vi.fn();
    await expect(executeGoogleFeedBuildStep(
      step("google", "google-market-BE_FR"),
      "worker-1",
      {} as never,
      {
        readCanonicals: async () => ({
          canonicals: [{
            id: "canonical-1",
            exclusionReasons: [],
            market: "BE_FR",
          } as never],
        }),
        getFrozenCanonicals: async (_input, create) => create(),
        verifySourceFingerprints: async () => {
          verification++;
          if (verification === 2) throw new Error("Source changed during capture");
        },
        mapGoogle: vi.fn(),
        uploadPart,
        completeStep: vi.fn(),
      },
    )).rejects.toThrow("Source changed during capture");
    expect(uploadPart).not.toHaveBeenCalled();
  });
});