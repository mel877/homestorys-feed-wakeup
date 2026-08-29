import { describe, expect, it, vi } from "vitest";
import {
  loadVerifiedFeedParts,
} from "../src/exporters/durable-feed-db-finalizer";
import { executeDurableFeedFinalizationStep } from "../src/exporters/durable-feed-finalizer";

const completed = (batchIndex: number, overrides: Record<string, unknown> = {}) => ({
  id: `step-${batchIndex}`,
  batchIndex,
  status: "completed",
  artifactPath: `feeds/google/versions/v1/google-fr-BE_FR.tsv.parts/${String(batchIndex).padStart(6, "0")}.jsonl`,
  sha256: `sha-${batchIndex}`,
  itemCount: 1,
  ...overrides,
});

const input = {
  syncRunId: "run-1",
  channel: "google" as const,
  marketCode: "BE_FR",
  language: "fr",
  fileKey: "google-market-BE_FR",
  versionedPath: "feeds/google/versions/v1/google-fr-BE_FR.tsv",
  requiredBatchIndexes: [0, 1],
};

describe("PostgreSQL-derived feed finalization", () => {
  it("loads and verifies every required part from persisted build steps", async () => {
    const parts = await loadVerifiedFeedParts(input, {
      loadSteps: vi.fn().mockResolvedValue([completed(0), completed(1)]),
      computeSha256: async (path) => path.includes("000000") ? "sha-0" : "sha-1",
    });
    expect(parts.map((part) => part.batchIndex)).toEqual([0, 1]);
  });

  it.each([
    {
      name: "missing part",
      rows: [completed(0)],
      hashes: ["sha-0"],
      error: "missing",
    },
    {
      name: "duplicate part",
      rows: [completed(0), completed(0), completed(1)],
      hashes: ["sha-0", "sha-1"],
      error: "duplicate",
    },
    {
      name: "unexpected path",
      rows: [completed(0, { artifactPath: "wrong.jsonl" }), completed(1)],
      hashes: ["sha-0", "sha-1"],
      error: "path",
    },
    {
      name: "checksum mismatch",
      rows: [completed(0), completed(1)],
      hashes: ["corrupt", "sha-1"],
      error: "checksum",
    },
  ])("refuses $name", async ({ rows, hashes, error }) => {
    let index = 0;
    await expect(loadVerifiedFeedParts(input, {
      loadSteps: vi.fn().mockResolvedValue(rows),
      computeSha256: vi.fn(async () => hashes[index++] ?? null),
    })).rejects.toThrow(error);
  });

  it("allows only one concurrent finalization to publish and complete", async () => {
    let locked = false;
    const finalize = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        status: "published" as const,
        published: true,
        itemCount: 2,
        sha256: "final-sha",
        versionedPath: input.versionedPath,
        validationErrors: [],
      };
    });
    const step = {
      id: "finalize-step",
      syncRunId: "run-1",
      channel: "google",
      stage: "finalize",
      marketCode: "BE_FR",
      language: "fr",
      status: "running",
      leaseOwner: "worker-1",
      checkpoint: {
        fileKey: input.fileKey,
        version: "v1",
        requiredBatchIndexes: [0, 1],
        contributingMarkets: ["BE_FR"],
      },
    } as never;
    const dependencies = {
      loadStep: vi.fn().mockResolvedValue(step),
      async withLock<T>(_key: string, callback: () => Promise<T>) {
        if (locked) return null;
        locked = true;
        try {
          return await callback();
        } finally {
          locked = false;
        }
      },
      loadParts: vi.fn().mockResolvedValue([
        { batchIndex: 0, artifactPath: "part-0", status: "completed" },
        { batchIndex: 1, artifactPath: "part-1", status: "completed" },
      ]),
      finalize,
      completeStep: vi.fn().mockResolvedValue(true),
    };

    const results = await Promise.allSettled([
      executeDurableFeedFinalizationStep({
        stepId: "finalize-step",
        workerId: "worker-1",
        config: {} as never,
        dryRun: false,
      }, dependencies),
      executeDurableFeedFinalizationStep({
        stepId: "finalize-step",
        workerId: "worker-1",
        config: {} as never,
        dryRun: false,
      }, dependencies),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(dependencies.completeStep).toHaveBeenCalledTimes(1);
  });
});