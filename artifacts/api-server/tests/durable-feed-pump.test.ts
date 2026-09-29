import { describe, expect, it, vi } from "vitest";
import {
  runDurableFeedPump,
  type DurableFeedPumpDependencies,
  type PumpClaim,
} from "../src/jobs/durable-feed-pump";

const { mockRunGoogleExport, mockRunMetaExport } = vi.hoisted(() => ({
  mockRunGoogleExport: vi.fn(),
  mockRunMetaExport: vi.fn(),
}));

vi.mock("../src/exporters/google/runner", () => ({
  runGoogleExport: mockRunGoogleExport,
}));
vi.mock("../src/exporters/meta/generator", () => ({
  runMetaExport: mockRunMetaExport,
}));

function step(overrides: Partial<PumpClaim["step"]> = {}): PumpClaim["step"] {
  return {
    id: "step-1",
    syncRunId: "run-1",
    channel: "google",
    stage: "build",
    marketCode: "BE_FR",
    language: "fr",
    batchIndex: 0,
    checkpoint: {
      fileKey: "google-market-BE_FR",
      version: "v1",
      productIds: ["product-1"],
      contributingMarkets: ["BE_FR"],
      sourceMarkets: ["BE_FR"],
      sourceFingerprints: { "product-1": "fingerprint" },
    },
    status: "running",
    attempts: 1,
    leaseOwner: "pump-worker",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    availableAt: null,
    startedAt: new Date(),
    completedAt: null,
    lastError: null,
    itemCount: null,
    artifactPath: null,
    sha256: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PumpClaim["step"];
}

function dependencies(
  claimNext: DurableFeedPumpDependencies["claimNext"],
  overrides: Partial<DurableFeedPumpDependencies> = {},
): DurableFeedPumpDependencies {
  return {
    recoverExpired: vi.fn().mockResolvedValue(0),
    claimNext,
    executeBuild: vi.fn().mockResolvedValue({
      artifactPath: "part.jsonl",
      itemCount: 1,
      sha256: "sha",
    }),
    executeFinalize: vi.fn().mockResolvedValue({
      status: "published",
      published: true,
      itemCount: 1,
      sha256: "sha",
      versionedPath: "feed.tsv",
      validationErrors: [],
    }),
    failStep: vi.fn().mockResolvedValue("retry"),
    deferStep: vi.fn().mockResolvedValue(true),
    now: () => Date.now(),
    ...overrides,
  };
}

describe("durable feed pump", () => {
  it("returns idle when no durable step is available", async () => {
    const deps = dependencies(vi.fn().mockResolvedValue(null));

    const result = await runDurableFeedPump({ workerId: "pump-worker" }, deps);

    expect(result.status).toBe("idle");
    expect(result.processed).toBe(0);
    expect(deps.recoverExpired).toHaveBeenCalledOnce();
  });

  it("claims and processes one bounded build step", async () => {
    const claimed = { step: step(), reclaimed: false };
    const deps = dependencies(
      vi.fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValueOnce(null),
    );

    const result = await runDurableFeedPump({ workerId: "pump-worker" }, deps);

    expect(result.status).toBe("processed");
    expect(result.processed).toBe(1);
    expect(deps.executeBuild).toHaveBeenCalledWith(claimed.step, "pump-worker", expect.anything());
    expect(deps.failStep).not.toHaveBeenCalled();
  });

  it("reports retry after a bounded step fails and persists the failure", async () => {
    const claimed = { step: step(), reclaimed: false };
    const deps = dependencies(
      vi.fn().mockResolvedValueOnce(claimed).mockResolvedValueOnce(null),
      { executeBuild: vi.fn().mockRejectedValue(new Error("Shopify temporarily unavailable")) },
    );

    const result = await runDurableFeedPump({ workerId: "pump-worker" }, deps);

    expect(result.status).toBe("retry");
    expect(result.processed).toBe(0);
    expect(deps.failStep).toHaveBeenCalledWith(
      claimed.step.id,
      "pump-worker",
      expect.any(Error),
    );
  });

  it("reports a terminal error when the maximum attempts are exhausted", async () => {
    const claimed = { step: step({ attempts: 5 }), reclaimed: true };
    const deps = dependencies(
      vi.fn().mockResolvedValueOnce(claimed),
      {
        executeBuild: vi.fn().mockRejectedValue(new Error("permanent failure")),
        failStep: vi.fn().mockResolvedValue("failed"),
      },
    );

    const result = await runDurableFeedPump({ workerId: "pump-worker" }, deps);

    expect(result.status).toBe("error");
    expect(result.steps[0]?.status).toBe("error");
  });

  it("reclaims an expired lease before processing", async () => {
    const deps = dependencies(
      vi.fn().mockResolvedValueOnce({ step: step({ attempts: 2 }), reclaimed: true })
        .mockResolvedValueOnce(null),
      { recoverExpired: vi.fn().mockResolvedValue(1) },
    );

    const result = await runDurableFeedPump({ workerId: "pump-worker" }, deps);

    expect(result.reclaimed).toBe(1);
    expect(result.status).toBe("processed");
  });

  it("dispatches a finalize step only to the durable DB finalizer", async () => {
    const finalize = step({
      stage: "finalize",
      checkpoint: {
        fileKey: "google-market-BE_FR",
        version: "v1",
        requiredBatchIndexes: [0],
        contributingMarkets: ["BE_FR"],
      },
    });
    const deps = dependencies(
      vi.fn().mockResolvedValueOnce({ step: finalize, reclaimed: false })
        .mockResolvedValueOnce(null),
    );

    const result = await runDurableFeedPump({ workerId: "pump-worker" }, deps);

    expect(result.status).toBe("processed");
    expect(deps.executeFinalize).toHaveBeenCalledWith(finalize, "pump-worker", expect.anything());
    expect(deps.executeBuild).not.toHaveBeenCalled();
  });

  it("reports finalization lock contention as a conflict, not a retry", async () => {
    const finalize = step({
      stage: "finalize",
      checkpoint: {
        fileKey: "google-market-BE_FR",
        version: "v1",
        requiredBatchIndexes: [0],
        contributingMarkets: ["BE_FR"],
      },
    });
    const deps = dependencies(
      vi.fn().mockResolvedValueOnce({ step: finalize, reclaimed: false }),
      {
        executeFinalize: vi.fn().mockRejectedValue(
          new Error("Feed finalization is already running for google-market-BE_FR"),
        ),
      },
    );

    const result = await runDurableFeedPump({ workerId: "pump-worker" }, deps);

    expect(result.status).toBe("conflict");
    expect(deps.failStep).not.toHaveBeenCalled();
  });

  it("does not process the same claimed step twice when calls overlap", async () => {
    let claimed = true;
    const executeBuild = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      claimed = false;
    });
    const deps = dependencies(
      vi.fn().mockImplementation(async () => {
        if (!claimed) return null;
        claimed = false;
        return { step: step(), reclaimed: false };
      }),
      { executeBuild },
    );

    await Promise.all([
      runDurableFeedPump({ workerId: "pump-a" }, deps),
      runDurableFeedPump({ workerId: "pump-b" }, deps),
    ]);

    expect(executeBuild).toHaveBeenCalledTimes(1);
  });

  it("stops before claiming another step when the time budget is exhausted", async () => {
    let clock = 0;
    const deps = dependencies(
      vi.fn()
        .mockResolvedValueOnce({ step: step(), reclaimed: false })
        .mockResolvedValueOnce({ step: step({ id: "step-2", batchIndex: 1 }), reclaimed: false }),
      {
        now: () => clock,
        executeBuild: vi.fn().mockImplementation(async () => {
          clock = 31_000;
        }),
      },
    );

    const result = await runDurableFeedPump(
      { workerId: "pump-worker", budgetMs: 30_000 },
      deps,
    );

    expect(result.processed).toBe(1);
    expect(deps.claimNext).toHaveBeenCalledTimes(1);
  });

  it("does not claim a step when lease recovery consumed the request budget", async () => {
    let clock = 0;
    const claimNext = vi.fn();
    const deps = dependencies(claimNext, {
      now: () => clock,
      recoverExpired: vi.fn().mockImplementation(async () => {
        clock = 30_000;
        return 1;
      }),
    });

    const result = await runDurableFeedPump(
      { workerId: "pump-worker", budgetMs: 30_000 },
      deps,
    );

    expect(result.status).toBe("idle");
    expect(claimNext).not.toHaveBeenCalled();
    expect(result.remainingBudgetMs).toBe(0);
  });

  it("continues from persisted claims after a simulated process restart", async () => {
    const queue = [
      { step: step({ id: "step-1", batchIndex: 0 }), reclaimed: false },
      { step: step({ id: "step-2", batchIndex: 1 }), reclaimed: false },
    ];
    const deps = dependencies(vi.fn().mockImplementation(async () => queue.shift() ?? null));

    const first = await runDurableFeedPump(
      { workerId: "first-process", maxSteps: 1 },
      deps,
    );
    const second = await runDurableFeedPump(
      { workerId: "restarted-process", maxSteps: 1 },
      deps,
    );

    expect(first.steps.map((entry) => entry.id)).toEqual(["step-1"]);
    expect(second.steps.map((entry) => entry.id)).toEqual(["step-2"]);
  });

  it("rejects unsupported publish stages instead of invoking a monolithic exporter", async () => {
    const deps = dependencies(
      vi.fn().mockResolvedValueOnce({
        step: step({ stage: "publish" }),
        reclaimed: false,
      }),
    );

    const result = await runDurableFeedPump({ workerId: "pump-worker" }, deps);

    expect(result.status).toBe("error");
    expect(deps.executeBuild).not.toHaveBeenCalled();
    expect(deps.executeFinalize).not.toHaveBeenCalled();
    expect(deps.failStep).toHaveBeenCalled();
    expect(mockRunGoogleExport).not.toHaveBeenCalled();
    expect(mockRunMetaExport).not.toHaveBeenCalled();
  });

  it("runs build steps in parallel lanes without claiming a step twice", async () => {
    const queue = Array.from({ length: 6 }, (_, index) => ({
      step: step({ id: `step-${index}`, batchIndex: index }),
      reclaimed: false,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const executeBuild = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return {};
    });
    const deps = dependencies(
      vi.fn(async () => queue.shift() ?? null),
      { executeBuild },
    );

    const result = await runDurableFeedPump(
      { workerId: "pump-worker", concurrency: 3, maxSteps: 16 },
      deps,
    );

    expect(result.status).toBe("processed");
    expect(result.processed).toBe(6);
    expect(maxInFlight).toBe(3);
    expect(new Set(result.steps.map((entry) => entry.id)).size).toBe(6);
  });

  it("stops every lane after a step failure and reports it", async () => {
    const queue = Array.from({ length: 6 }, (_, index) => ({
      step: step({ id: `step-${index}`, batchIndex: index }),
      reclaimed: false,
    }));
    const executeBuild = vi.fn(async (claimed: PumpClaim["step"]) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (claimed.id === "step-1") throw new Error("boom");
      return {};
    });
    const deps = dependencies(
      vi.fn(async () => queue.shift() ?? null),
      { executeBuild },
    );

    const result = await runDurableFeedPump(
      { workerId: "pump-worker", concurrency: 3, maxSteps: 16 },
      deps,
    );

    expect(result.status).toBe("retry");
    expect(result.error).toBe("boom");
    expect(deps.failStep).toHaveBeenCalledTimes(1);
    expect(queue.length).toBeGreaterThan(0);
  });

  it("stays sequential by default", async () => {
    const queue = Array.from({ length: 3 }, (_, index) => ({
      step: step({ id: `step-${index}` }),
      reclaimed: false,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const executeBuild = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return {};
    });
    const deps = dependencies(vi.fn(async () => queue.shift() ?? null), { executeBuild });

    await runDurableFeedPump({ workerId: "pump-worker" }, deps);

    expect(maxInFlight).toBe(1);
  });
});

