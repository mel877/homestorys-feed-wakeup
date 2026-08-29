import { describe, expect, it, vi } from "vitest";
import {
  executeGoogleFeedBuildStep,
  executeMetaFeedBuildStep,
  type DurableFeedBuildStep,
} from "../src/exporters/durable-feed-builders";

const step = (channel: "google" | "meta", fileKey: string): DurableFeedBuildStep => ({
  id: "step-1",
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
        processCanonicals: async (_config, options, callback) => {
          expect(options).toMatchObject({
            productIds: ["product-1"],
            markets: ["BE_FR"],
            channel: "google",
          });
          await callback({ id: "canonical-1" } as never);
        },
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
        processCanonicals: async (_config, _options, callback) => {
          await callback({ id: "canonical-1" } as never);
        },
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
});