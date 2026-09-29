import { describe, expect, it, vi } from "vitest";
import {
  advanceNightlyCycle,
  type NightlyCycleDependencies,
} from "../src/jobs/nightly-cycle";

function dependencies(
  overrides: Partial<NightlyCycleDependencies> = {},
): NightlyCycleDependencies {
  return {
    advanceShopify: vi.fn().mockResolvedValue({
      status: "running",
      runId: "shopify-run-1",
      phase: "pricing",
      processed: 1,
      reclaimed: 0,
    }),
    planFeed: vi.fn(),
    pumpFeed: vi.fn(),
    getFeedSummary: vi.fn(),
    completeFeedRun: vi.fn().mockResolvedValue(undefined),
    failFeedRun: vi.fn().mockResolvedValue(undefined),
    settleFeedRun: vi.fn().mockResolvedValue({
      skipped: 0,
      claimable: 1,
      waitingRetry: 0,
      leased: 0,
      stuckSteps: [],
    }),
    findActiveFeedRun: vi.fn().mockResolvedValue(null),
    listUnpublishedFiles: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("nightly cycle orchestration", () => {
  it("does not create a feed plan while Shopify is incomplete", async () => {
    const deps = dependencies();

    const result = await advanceNightlyCycle({
      cycleKey: "2026-08-30",
      workerId: "nightly-1",
    }, deps);

    expect(result.status).toBe("running");
    expect(result.phase).toBe("pricing");
    expect(deps.planFeed).not.toHaveBeenCalled();
    expect(deps.pumpFeed).not.toHaveBeenCalled();
  });

  it("does not create a feed plan after a failed Shopify refresh", async () => {
    const deps = dependencies({
      advanceShopify: vi.fn().mockResolvedValue({
        status: "failed",
        runId: "shopify-run-1",
        phase: "inventory",
        processed: 0,
        reclaimed: 1,
        error: "inventory failed",
      }),
    });

    const result = await advanceNightlyCycle({
      cycleKey: "2026-08-30",
      workerId: "nightly-1",
    }, deps);

    expect(result.status).toBe("failed");
    expect(deps.planFeed).not.toHaveBeenCalled();
  });

  it("creates exactly one source-linked feed plan after Shopify succeeds", async () => {
    const planFeed = vi.fn().mockResolvedValue({
      status: "planned",
      runId: "feed-run-1",
      totalSteps: 190,
    });
    const deps = dependencies({
      advanceShopify: vi.fn().mockResolvedValue({
        status: "completed",
        runId: "shopify-run-1",
        phase: "completion",
        processed: 1,
        reclaimed: 0,
      }),
      planFeed,
      pumpFeed: vi.fn().mockResolvedValue({ status: "processed", processed: 8 }),
      getFeedSummary: vi.fn().mockResolvedValue({
        total: 190,
        pending: 182,
        running: 0,
        completed: 8,
        failed: 0,
      }),
    });

    const result = await advanceNightlyCycle({
      cycleKey: "2026-08-30",
      workerId: "nightly-1",
    }, deps);

    expect(planFeed).toHaveBeenCalledTimes(1);
    expect(planFeed).toHaveBeenCalledWith({
      trigger: "nightly",
      sourceSyncRunId: "shopify-run-1",
      idempotencyKey: "shopify-run-1",
    });
    expect(result.status).toBe("running");
    expect(result.phase).toBe("feeds");
  });

  it("reuses an existing plan for the same Shopify run", async () => {
    const deps = dependencies({
      advanceShopify: vi.fn().mockResolvedValue({
        status: "completed",
        runId: "shopify-run-1",
        phase: "completion",
        processed: 0,
        reclaimed: 0,
      }),
      planFeed: vi.fn().mockResolvedValue({
        status: "existing",
        runId: "feed-run-1",
        totalSteps: 190,
      }),
      pumpFeed: vi.fn().mockResolvedValue({ status: "idle", processed: 0 }),
      getFeedSummary: vi.fn().mockResolvedValue({
        total: 190,
        pending: 0,
        running: 0,
        completed: 190,
        failed: 0,
      }),
    });

    const result = await advanceNightlyCycle({
      cycleKey: "2026-08-30",
      workerId: "nightly-1",
    }, deps);

    expect(result.status).toBe("completed");
    expect(result.feedRunId).toBe("feed-run-1");
  });

  const completedShopify = () => vi.fn().mockResolvedValue({
    status: "completed",
    runId: "shopify-run-2",
    phase: "completion",
    processed: 0,
    reclaimed: 0,
  });

  it("drives a blocking previous feed run instead of waiting on it forever", async () => {
    const pumpFeed = vi.fn().mockResolvedValue({ status: "idle", processed: 0 });
    const completeFeedRun = vi.fn().mockResolvedValue(undefined);
    const settleFeedRun = vi.fn().mockResolvedValue({
      skipped: 2,
      claimable: 0,
      waitingRetry: 0,
      leased: 0,
      stuckSteps: [],
    });
    const deps = dependencies({
      advanceShopify: completedShopify(),
      planFeed: vi.fn().mockResolvedValue({ status: "conflict", totalSteps: 0 }),
      findActiveFeedRun: vi.fn().mockResolvedValue({ runId: "old-feed-run" }),
      pumpFeed,
      settleFeedRun,
      completeFeedRun,
      getFeedSummary: vi.fn().mockResolvedValue({
        total: 190, pending: 0, running: 0, completed: 190, failed: 0,
      }),
    });

    const result = await advanceNightlyCycle({ cycleKey: "2026-09-28", workerId: "n" }, deps);

    expect(pumpFeed).toHaveBeenCalledTimes(1);
    expect(settleFeedRun).toHaveBeenCalledWith("old-feed-run");
    expect(completeFeedRun).toHaveBeenCalledWith("old-feed-run");
    expect(result).toMatchObject({
      status: "running",
      phase: "feeds",
      blockingFeedRunId: "old-feed-run",
    });
  });

  it("fails a deadlocked feed run so it cannot block the next plan", async () => {
    const failFeedRun = vi.fn().mockResolvedValue(undefined);
    const deps = dependencies({
      advanceShopify: completedShopify(),
      planFeed: vi.fn().mockResolvedValue({ status: "existing", runId: "feed-run-2", totalSteps: 0 }),
      pumpFeed: vi.fn().mockResolvedValue({ status: "idle", processed: 0 }),
      settleFeedRun: vi.fn().mockResolvedValue({
        skipped: 0,
        claimable: 0,
        waitingRetry: 0,
        leased: 0,
        stuckSteps: [{ id: "step-1", stage: "finalize", fileKey: "meta-market-FR" }],
      }),
      failFeedRun,
      getFeedSummary: vi.fn().mockResolvedValue({
        total: 190, pending: 1, running: 0, completed: 189, failed: 0,
      }),
    });

    const result = await advanceNightlyCycle({ cycleKey: "2026-09-28", workerId: "n" }, deps);

    expect(result.status).toBe("failed");
    expect(result.stuckSteps).toHaveLength(1);
    expect(failFeedRun).toHaveBeenCalledWith("feed-run-2", expect.stringContaining("deadlocked"));
  });

  it("marks the feed run failed when a step exhausted its retries", async () => {
    const failFeedRun = vi.fn().mockResolvedValue(undefined);
    const deps = dependencies({
      advanceShopify: completedShopify(),
      planFeed: vi.fn().mockResolvedValue({ status: "existing", runId: "feed-run-2", totalSteps: 0 }),
      pumpFeed: vi.fn().mockResolvedValue({ status: "error", processed: 0, error: "boom" }),
      failFeedRun,
      getFeedSummary: vi.fn().mockResolvedValue({
        total: 190, pending: 10, running: 0, completed: 179, failed: 1,
      }),
    });

    const result = await advanceNightlyCycle({ cycleKey: "2026-09-28", workerId: "n" }, deps);

    expect(result).toMatchObject({ status: "failed", error: "boom" });
    expect(failFeedRun).toHaveBeenCalledWith("feed-run-2", "boom");
  });

  it("stays idle while steps wait for a retry backoff", async () => {
    const failFeedRun = vi.fn();
    const deps = dependencies({
      advanceShopify: completedShopify(),
      planFeed: vi.fn().mockResolvedValue({ status: "existing", runId: "feed-run-2", totalSteps: 0 }),
      pumpFeed: vi.fn().mockResolvedValue({ status: "idle", processed: 0 }),
      settleFeedRun: vi.fn().mockResolvedValue({
        skipped: 0, claimable: 0, waitingRetry: 1, leased: 0, stuckSteps: [],
      }),
      failFeedRun,
      getFeedSummary: vi.fn().mockResolvedValue({
        total: 190, pending: 1, running: 0, completed: 189, failed: 0,
      }),
    });

    const result = await advanceNightlyCycle({ cycleKey: "2026-09-28", workerId: "n" }, deps);

    expect(result.status).toBe("idle");
    expect(failFeedRun).not.toHaveBeenCalled();
  });

  it("reports feeds kept back by the publication gate on completion", async () => {
    const deps = dependencies({
      advanceShopify: completedShopify(),
      planFeed: vi.fn().mockResolvedValue({ status: "existing", runId: "feed-run-2", totalSteps: 0 }),
      pumpFeed: vi.fn().mockResolvedValue({ status: "idle", processed: 0 }),
      listUnpublishedFiles: vi.fn().mockResolvedValue([
        { fileKey: "meta-language-fr", result: "blocked" },
      ]),
      getFeedSummary: vi.fn().mockResolvedValue({
        total: 190, pending: 0, running: 0, completed: 190, failed: 0,
      }),
    });

    const result = await advanceNightlyCycle({ cycleKey: "2026-09-28", workerId: "n" }, deps);

    expect(result.status).toBe("completed");
    expect(result.unpublishedFiles).toEqual([{ fileKey: "meta-language-fr", result: "blocked" }]);
  });
});
