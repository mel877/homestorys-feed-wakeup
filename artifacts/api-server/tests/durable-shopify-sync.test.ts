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
    renewLease: vi.fn().mockResolvedValue(true),
    saveProgress: vi.fn().mockResolvedValue(true),
    executePhase: vi.fn().mockResolvedValue({
      status: "completed",
      checkpoint: { done: true },
    }),
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
    expect(deps.executePhase).toHaveBeenCalledWith(
      products.step,
      expect.objectContaining({
        workerId: "worker-1",
        budgetMs: 25_000,
      }),
    );
    expect(deps.completeStep).toHaveBeenCalledWith(
      products.step.id,
      "worker-1",
      { checkpoint: { done: true } },
    );
  });

  it("persists a partial phase checkpoint without completing the step", async () => {
    const products = claim("products");
    const deps = dependencies({
      claimNext: vi.fn().mockResolvedValue(products),
      executePhase: vi.fn().mockResolvedValue({
        status: "running",
        cursor: { nextBatchIndex: 4 },
        checkpoint: {
          stage: "batches",
          operationId: "gid://shopify/BulkOperation/1",
          resultUrl: "https://example.test/results.jsonl",
        },
      }),
    });

    const result = await runDurableShopifySyncSlice({
      cycleKey: "2026-08-30",
      workerId: "worker-1",
      maxSteps: 1,
    }, deps);

    expect(result.status).toBe("running");
    expect(deps.saveProgress).toHaveBeenCalledWith(
      products.step.id,
      "worker-1",
      {
        cursor: { nextBatchIndex: 4 },
        checkpoint: {
          stage: "batches",
          operationId: "gid://shopify/BulkOperation/1",
          resultUrl: "https://example.test/results.jsonl",
        },
      },
    );
    expect(deps.completeStep).not.toHaveBeenCalled();
  });

  it.each(["pricing", "inventory", "translations", "images"] as const)(
    "provides a bounded deadline to the %s phase",
    async (phase) => {
      const step = claim(phase);
      const executePhase = vi.fn().mockImplementation(async (_step, context) => ({
        status: "running" as const,
        checkpoint: {
          budgetMs: context.budgetMs,
          hasFutureDeadline: context.deadlineMs >= Date.now(),
        },
      }));
      const deps = dependencies({
        claimNext: vi.fn().mockResolvedValue(step),
        executePhase,
      });

      await runDurableShopifySyncSlice({
        cycleKey: "2026-08-30",
        workerId: "worker-1",
        maxSteps: 1,
        budgetMs: 1_000,
      }, deps);

      expect(executePhase).toHaveBeenCalledWith(
        step.step,
        expect.objectContaining({ budgetMs: 1_000, deadlineMs: expect.any(Number) }),
      );
      expect(deps.saveProgress).toHaveBeenCalledWith(
        step.step.id,
        "worker-1",
        expect.objectContaining({
          checkpoint: expect.objectContaining({ hasFutureDeadline: true }),
        }),
      );
    },
  );

  it("passes persisted translation resource progress back into the phase", async () => {
    const translations = claim("translations");
    translations.step.cursor = {
      localeIndex: 1,
      cursor: "shopify-page-2",
      resourceIndex: 42,
      page: [{ resourceId: "gid://shopify/Product/42", translations: [] }],
    };
    const deps = dependencies({
      claimNext: vi.fn().mockResolvedValue(translations),
      executePhase: vi.fn().mockResolvedValue({
        status: "running",
        cursor: { ...translations.step.cursor, resourceIndex: 43 },
      }),
    });
    await runDurableShopifySyncSlice({ cycleKey: "2026-08-30", workerId: "worker-1" }, deps);
    expect(deps.saveProgress).toHaveBeenCalledWith(
      translations.step.id, "worker-1",
      expect.objectContaining({ cursor: expect.objectContaining({ resourceIndex: 43 }) }),
    );
  });

  it("stops before executing a phase when its lease can no longer be renewed", async () => {
    const products = claim("products");
    const deps = dependencies({
      claimNext: vi.fn().mockResolvedValue(products),
      renewLease: vi.fn().mockResolvedValue(false),
    });

    const result = await runDurableShopifySyncSlice({
      cycleKey: "2026-08-30",
      workerId: "worker-1",
      maxSteps: 1,
    }, deps);

    expect(result.status).toBe("running");
    expect(result.error).toBe("Shopify step lease ownership was lost");
    expect(deps.executePhase).not.toHaveBeenCalled();
    expect(deps.completeStep).not.toHaveBeenCalled();
    expect(deps.saveProgress).not.toHaveBeenCalled();
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
      expect.objectContaining({ workerId: "worker-1" }),
    );
  });

  it("does not complete the Shopify run when pricing or inventory freshness fails", async () => {
    const completion = claim("completion");
    const deps = dependencies({
      claimNext: vi.fn().mockResolvedValue(completion),
      executePhase: vi.fn().mockResolvedValue({
        status: "completed",
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