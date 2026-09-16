import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const committed: string[] = [];
  const activeRows: Array<{ id: string }> = [];
  let failStepsInsert = false;
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const staged: string[] = [];
    const tx = {
      execute: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ rows: activeRows }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
      insert: vi.fn((table: { name: string }) => ({
        values: vi.fn(async () => {
          staged.push(table.name);
          if (table.name === "feed_export_steps" && failStepsInsert) {
            throw new Error("steps insert failed");
          }
        }),
      })),
    };
    const result = await callback(tx);
    committed.push(...staged);
    return result;
  });
  return {
    committed,
    activeRows,
    transaction,
    setFailStepsInsert(value: boolean) {
      failStepsInsert = value;
    },
  };
});

vi.mock("@workspace/db", () => ({
  db: { transaction: mocks.transaction },
  pool: {},
  feedExportStepsTable: {
    name: "feed_export_steps",
    id: "id",
    status: "status",
  },
  syncRunsTable: { name: "sync_runs" },
}));

import { persistDurableFeedRunPlan } from "../src/jobs/feed-export-step-repository";

const input = {
  runId: "00000000-0000-0000-0000-000000000001",
  metadata: { architecture: "durable-feed" },
  specs: [{
    syncRunId: "00000000-0000-0000-0000-000000000001",
    channel: "google" as const,
    stage: "build" as const,
    marketCode: "BE_FR",
    language: "fr",
    batchIndex: 0,
  }],
};

beforeEach(() => {
  mocks.committed.length = 0;
  mocks.activeRows.length = 0;
  mocks.setFailStepsInsert(false);
  mocks.transaction.mockClear();
});

describe("persistDurableFeedRunPlan", () => {
  it("commits the sync run and all steps through one transaction", async () => {
    const result = await persistDurableFeedRunPlan(input);

    expect(result).toEqual({ status: "planned", insertedSteps: 1 });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.committed).toEqual(["sync_runs", "feed_export_steps"]);
  });

  it("commits nothing when step insertion fails", async () => {
    mocks.setFailStepsInsert(true);

    await expect(persistDurableFeedRunPlan(input)).rejects.toThrow("steps insert failed");
    expect(mocks.committed).toEqual([]);
  });

  it("inserts nothing when an active pending or running plan exists", async () => {
    mocks.activeRows.push({ id: "active-step" });

    const result = await persistDurableFeedRunPlan(input);

    expect(result).toEqual({ status: "conflict", insertedSteps: 0 });
    expect(mocks.committed).toEqual([]);
  });
});