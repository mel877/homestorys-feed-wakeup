import { describe, expect, it, vi } from "vitest";
import {
  REQUIRED_SHOPIFY_PHASES,
  runDurableShopifySyncSlice,
  type DurableShopifySyncDependencies,
  type ShopifySyncClaim,
} from "../src/jobs/durable-shopify-sync";

function claim(phase: ShopifySyncClaim["step"]["phase"], attempts = 1): ShopifySyncClaim {
  return {
    reclaimed: attempts > 1,
    step: {
      id: `step-${phase}`,
      syncRunId: "shopify-run-1",
      phase,
      sequence: REQUIRED_SHOPIFY_PHASES.indexOf(phase),
      batchIndex: 0,
      cursor: null,
      checkpoint: null,
      status: "running",
      attempts,
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date("2026-08-30T02:05:00Z"),
      availableAt: null,
      startedAt: new Date("2026-08-30T02:00:00Z"),
      completedAt: null,
      lastError: null,
      createdAt: new Date("2026-08-30T02:00:00Z"),
      updatedAt: new Date("2026-08-30T02:00:00Z"),
    },
  };
}

function dependencies(
  overrides: Partial<DurableShopifySyncDependencies> = {},
): DurableShopifySyncDependencies {
  return {
    ensureRun: vi.fn().mockResolvedValue({ runId: "shopify-run-1", created: false }),
    releaseExpiredLeases: vi.fn().mockResolvedValue(0),
    claimNext: vi.fn().mockResolvedValue(null),
    executePhase: vi.fn().mockResolvedValue({ checkpoint: { done: true } }),
    completeStep: vi.fn().mockResolvedValue(true),
    failStep: vi.fn().mockResolvedValue("retry"),
    getSummary: vi.fn().mockResolvedValue({
      total: 6,
      pending: 5,
      running: 0,
      completed: 1,
      failed: 0,
    }),
    validateGate: vi.fn().mockResolvedValue({ ok: false, reasons: ["incomplete"] }),
    completeRun: vi.fn().mockResolvedValue(undefined),
    failRun: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("durable Shopify sync", () => {
  it("defines the mandatory phases in dependency order", () => {
    expect(REQUIRED_SHOPIFY_PHASES).toEqual([
      "products",
      "pricing",
      "inventory",
      "translations",
      "images",
      "completion",
    ]);
  });

  it("processes one claimed phase and persists its checkpoint", async () => {
    const products = claim("products");
    const deps = dependencies({
      claimNext: vi.fn().mockResolvedValue(products),
    });

    const result = await runDurableShopifySyncSlice({
      cycleKey: "2026-08-30",
      workerId: "worker-1",
      maxSteps: 1,
    }, deps);

    expect(result.status).toBe("running");
    expect(deps.executePhase).toHaveBeenCalledWith(products.step, "worker-1");
    expect(deps.completeStep).toHaveBeenCalledWith(
      products.step.id,
      "worker-1",
      { checkpoint: { done: true } },
    );
  });

  it("reclaims an expired lease and resumes from the persisted checkpoint", async () => {
    const pricing = claim("pricing", 2);
    pricing.step.checkpoint = { marketIndex: 3 };
    const deps = dependencies({
      releaseExpiredLeases: vi.fn().mockResolvedValue(1),
      claimNext: vi.fn().mockResolvedValue(pricing),
    });

    const result = await runDurableShopifySyncSlice({
      cycleKey: "2026-08-30",
      workerId: "worker-1",
      maxSteps: 1,
    }, deps);

    expect(result.reclaimed).toBe(1);
    expect(deps.executePhase).toHaveBeenCalledWith(
      expect.objectContaining({ checkpoint: { marketIndex: 3 } }),
      "worker-1",
    );
  });

  it("does not complete the Shopify run when pricing or inventory freshness fails", async () => {
    const completion = claim("completion");
    const deps = dependencies({
      claimNext: vi.fn().mockResolvedValue(completion),
      executePhase: vi.fn().mockResolvedValue({
        checkpoint: { gate: { ok: false, reasons: ["pricing stale"] } },
      }),
      getSummary: vi.fn().mockResolvedValue({
        total: 6,
        pending: 0,
        running: 0,
        completed: 6,
        failed: 0,
      }),
      validateGate: vi.fn().mockResolvedValue({
        ok: false,
        reasons: ["pricing stale"],
      }),
    });

    const result = await runDurableShopifySyncSlice({
      cycleKey: "2026-08-30",
      workerId: "worker-1",
      maxSteps: 1,
    }, deps);

    expect(result.status).toBe("failed");
    expect(deps.completeRun).not.toHaveBeenCalled();
    expect(deps.failRun).toHaveBeenCalled();
  });

  it("marks the parent run complete only after every mandatory phase and gate succeeds", async () => {
    const deps = dependencies({
      getSummary: vi.fn().mockResolvedValue({
        total: 6,
        pending: 0,
        running: 0,
        completed: 6,
        failed: 0,
      }),
      validateGate: vi.fn().mockResolvedValue({ ok: true, reasons: [] }),
    });

    const result = await runDurableShopifySyncSlice({
      cycleKey: "2026-08-30",
      workerId: "worker-1",
    }, deps);

    expect(result.status).toBe("completed");
    expect(deps.completeRun).toHaveBeenCalledWith("shopify-run-1");
  });

  it("never completes or plans past a terminal failed Shopify step", async () => {
    const deps = dependencies({
      getSummary: vi.fn().mockResolvedValue({
        total: 6,
        pending: 0,
        running: 0,
        completed: 5,
        failed: 1,
      }),
    });

    const result = await runDurableShopifySyncSlice({
      cycleKey: "2026-08-30",
      workerId: "worker-1",
    }, deps);

    expect(result.status).toBe("failed");
    expect(deps.completeRun).not.toHaveBeenCalled();
    expect(deps.failRun).toHaveBeenCalled();
  });
});