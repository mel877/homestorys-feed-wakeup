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
});