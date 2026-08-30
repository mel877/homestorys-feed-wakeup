import { describe, expect, it, vi } from "vitest";
import {
  planDurableFeedRun,
  type DurableFeedPlannerDependencies,
} from "../src/jobs/durable-feed-planner";

function config() {
  return {
    markets: {
      markets: {
        BE_FR: { country: "BE", language: "fr" },
        BE_DE: { country: "BE", language: "de" },
        FR: { country: "FR", language: "fr" },
        DE: { country: "DE", language: "de" },
        AT: { country: "AT", language: "de" },
        CH_DE: { country: "CH", language: "de" },
        CH_FR: { country: "CH", language: "fr" },
        LU_DE: { country: "LU", language: "de" },
      },
    },
    languages: { languages: [{ code: "fr" }, { code: "de" }, { code: "en" }, { code: "it" }] },
  } as never;
}

function dependencies(
  overrides: Partial<DurableFeedPlannerDependencies> = {},
): DurableFeedPlannerDependencies {
  return {
    listActiveProductIds: vi.fn().mockResolvedValue(["p-2", "p-1"]),
    computeFingerprints: vi.fn().mockResolvedValue({
      "p-1": "hash-1",
      "p-2": "hash-2",
    }),
    getConfig: () => config(),
    persistPlan: vi.fn().mockResolvedValue({
      status: "planned",
      insertedSteps: 38,
    }),
    now: () => new Date("2026-08-29T17:00:00.000Z"),
    validateSourceRun: vi.fn().mockResolvedValue(true),
    findExistingPlan: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("planDurableFeedRun", () => {
  it("creates one atomic Google+Meta plan without running the pump or touching snapshots", async () => {
    const deps = dependencies();

    const result = await planDurableFeedRun(
      { confirmation: "PLAN_DURABLE_FEEDS" },
      deps,
    );

    expect(result.status).toBe("planned");
    expect(result.productCount).toBe(2);
    expect(result.buildSteps).toBe(19);
    expect(result.finalizeSteps).toBe(19);
    expect(result.totalSteps).toBe(38);
    expect(deps.persistPlan).toHaveBeenCalledTimes(1);
    expect(deps.persistPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          architecture: "durable-feed",
          productCount: 2,
        }),
        specs: expect.arrayContaining([
          expect.objectContaining({ channel: "google", stage: "build" }),
          expect.objectContaining({ channel: "meta", stage: "finalize" }),
        ]),
      }),
    );
  });

  it("refuses a second plan when the atomic persistence layer finds an active cycle", async () => {
    const deps = dependencies({
      persistPlan: vi.fn().mockResolvedValue({ status: "conflict", insertedSteps: 0 }),
    });

    const result = await planDurableFeedRun(
      { confirmation: "PLAN_DURABLE_FEEDS" },
      deps,
    );

    expect(result.status).toBe("conflict");
    expect(result.totalSteps).toBe(0);
  });

  it("creates a source-linked nightly plan without weakening manual confirmation", async () => {
    const deps = dependencies();

    await planDurableFeedRun({
      trigger: "nightly",
      sourceSyncRunId: "shopify-run-1",
      idempotencyKey: "shopify-run-1",
    }, deps);

    expect(deps.persistPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSyncRunId: "shopify-run-1",
        metadata: expect.objectContaining({
          trigger: "nightly",
          sourceSyncRunId: "shopify-run-1",
          idempotencyKey: "shopify-run-1",
        }),
      }),
    );
  });

  it("returns the existing plan for an already planned Shopify refresh", async () => {
    const deps = dependencies({
      findExistingPlan: vi.fn().mockResolvedValue({
        runId: "feed-run-existing",
      }),
    });

    const result = await planDurableFeedRun({
      trigger: "nightly",
      sourceSyncRunId: "shopify-run-1",
      idempotencyKey: "shopify-run-1",
    }, deps);

    expect(result.status).toBe("existing");
    expect(result.runId).toBe("feed-run-existing");
    expect(deps.listActiveProductIds).not.toHaveBeenCalled();
    expect(deps.persistPlan).not.toHaveBeenCalled();
  });

  it("rejects a nightly plan that is not tied to a validated source run", async () => {
    const deps = dependencies();

    await expect(planDurableFeedRun({
      trigger: "nightly",
      sourceSyncRunId: "shopify-run-1",
      idempotencyKey: "different-run",
    }, deps)).rejects.toThrow("validated source sync run id");
    expect(deps.persistPlan).not.toHaveBeenCalled();
  });

  it("refuses a nightly plan when the source Shopify gate is not completed", async () => {
    const deps = dependencies({
      validateSourceRun: vi.fn().mockResolvedValue(false),
    });

    await expect(planDurableFeedRun({
      trigger: "nightly",
      sourceSyncRunId: "shopify-run-failed",
      idempotencyKey: "shopify-run-failed",
    }, deps)).rejects.toThrow("did not pass the Shopify completion gate");
    expect(deps.listActiveProductIds).not.toHaveBeenCalled();
    expect(deps.persistPlan).not.toHaveBeenCalled();
  });

  it("does not persist a plan when a product fingerprint is missing", async () => {
    const deps = dependencies({
      computeFingerprints: vi.fn().mockResolvedValue({ "p-1": "hash-1" }),
    });

    await expect(planDurableFeedRun(
      { confirmation: "PLAN_DURABLE_FEEDS" },
      deps,
    )).rejects.toThrow("Missing source fingerprint for product p-2");
    expect(deps.persistPlan).not.toHaveBeenCalled();
  });

  it("generates exactly 171 builds and 19 finalizers for 2,129 products", async () => {
    const productIds = Array.from(
      { length: 2_129 },
      (_, index) => `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    );
    const deps = dependencies({
      listActiveProductIds: vi.fn().mockResolvedValue(productIds),
      computeFingerprints: vi.fn().mockResolvedValue(
        Object.fromEntries(productIds.map((id) => [id, `hash-${id}`])),
      ),
      persistPlan: vi.fn().mockResolvedValue({
        status: "planned",
        insertedSteps: 190,
      }),
    });

    const result = await planDurableFeedRun(
      { confirmation: "PLAN_DURABLE_FEEDS" },
      deps,
    );

    expect(result).toMatchObject({
      productCount: 2_129,
      buildSteps: 171,
      finalizeSteps: 19,
      totalSteps: 190,
    });
  });

  it("refuses to create a durable run for an empty catalog", async () => {
    const deps = dependencies({
      listActiveProductIds: vi.fn().mockResolvedValue([]),
      computeFingerprints: vi.fn().mockResolvedValue({}),
    });

    await expect(planDurableFeedRun(
      { confirmation: "PLAN_DURABLE_FEEDS" },
      deps,
    )).rejects.toThrow("No active products available for durable feed planning");
    expect(deps.persistPlan).not.toHaveBeenCalled();
  });
});