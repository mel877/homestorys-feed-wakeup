import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let rows: Array<Record<string, unknown>> = [];
  let committed = false;
  let rolledBack = false;

  const execute = vi.fn(async () => ({ rows }));
  const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => {
    const tx = { execute };
    try {
      const result = await callback(tx);
      committed = true;
      return result;
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  });

  return {
    execute,
    transaction,
    setRows(value: Array<Record<string, unknown>>) {
      rows = value;
    },
    get committed() {
      return committed;
    },
    get rolledBack() {
      return rolledBack;
    },
    reset() {
      rows = [];
      committed = false;
      rolledBack = false;
      execute.mockClear();
      transaction.mockClear();
    },
  };
});

vi.mock("@workspace/db", () => ({
  db: { transaction: mocks.transaction },
  pool: {},
  feedExportStepsTable: {},
  syncRunsTable: {},
}));

import {
  FeedFinalizerRequeueCardinalityError,
  requeueBlockedMetaFinalizers,
} from "../src/jobs/feed-export-step-repository";

const syncRunId = "26f87a65-9830-44f2-9d39-67c0b4e5eee8";

function rows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: `step-${index}`,
    market_code: `MARKET_${index}`,
    language: index % 2 === 0 ? "fr" : "de",
    batch_index: index,
    checkpoint: {
      result: "blocked",
      published: false,
      attemptsMustRemain: index + 1,
    },
    attempts: index + 2,
  }));
}

function staticSql(query: unknown): string {
  const chunks = (query as { queryChunks: Array<{ value?: string[] }> }).queryChunks;
  return chunks
    .filter((chunk) => Array.isArray(chunk.value))
    .flatMap((chunk) => chunk.value ?? [])
    .join("");
}

beforeEach(() => {
  mocks.reset();
});

describe("requeueBlockedMetaFinalizers", () => {
  it("commits exactly nine matching finalizers", async () => {
    mocks.setRows(rows(9));

    const result = await requeueBlockedMetaFinalizers(syncRunId);

    expect(result).toMatchObject({
      count: 9,
      targets: expect.arrayContaining([
        {
          id: "step-0",
          marketCode: "MARKET_0",
          language: "fr",
          batchIndex: 0,
        },
      ]),
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.committed).toBe(true);
    expect(mocks.rolledBack).toBe(false);
  });

  it.each([8, 10])("rolls back when %i rows match instead of nine", async (count) => {
    mocks.setRows(rows(count));

    await expect(requeueBlockedMetaFinalizers(syncRunId)).rejects.toEqual(
      new FeedFinalizerRequeueCardinalityError(count),
    );

    expect(mocks.committed).toBe(false);
    expect(mocks.rolledBack).toBe(true);
  });

  it("does not update checkpoint or attempts", async () => {
    mocks.setRows(rows(9));

    await requeueBlockedMetaFinalizers(syncRunId);

    const query = mocks.execute.mock.calls[0]?.[0];
    const setClause = staticSql(query).split("WHERE")[0];
    expect(setClause).not.toContain("checkpoint");
    expect(setClause).not.toContain("attempts");
  });
});