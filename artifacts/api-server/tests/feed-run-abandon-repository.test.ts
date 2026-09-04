import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_ID = "79362d72-9303-4a3b-8d92-9a81d932c079";

const mocks = vi.hoisted(() => {
  let responses: Array<Array<Record<string, unknown>>> = [];
  const execute = vi.fn(async () => ({ rows: responses.shift() ?? [] }));
  const transaction = vi.fn(async (
    callback: (tx: { execute: typeof execute }) => Promise<unknown>,
  ) => callback({ execute }));

  return {
    execute,
    transaction,
    setResponses(value: Array<Array<Record<string, unknown>>>) {
      responses = value;
    },
    reset() {
      responses = [];
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
  abandonDurableFeedRun,
  DurableFeedRunAbandonError,
} from "../src/jobs/feed-export-step-repository";

function staticSql(query: unknown): string {
  const chunks = (query as { queryChunks: Array<{ value?: string[] }> }).queryChunks;
  return chunks
    .filter((chunk) => Array.isArray(chunk.value))
    .flatMap((chunk) => chunk.value ?? [])
    .join("");
}

function validRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    run_type: "export",
    status: "failed",
    architecture: "durable-feed",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.reset();
});

describe("abandonDurableFeedRun", () => {
  it("abandons only pending steps from the requested durable feed run", async () => {
    mocks.setResponses([
      [],
      [validRun()],
      [],
      [{ id: "pending-1" }, { id: "pending-2" }],
    ]);

    const result = await abandonDurableFeedRun(RUN_ID);

    expect(result).toEqual({ syncRunId: RUN_ID, abandonedSteps: 2 });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);

    const lockQuery = staticSql(mocks.execute.mock.calls[0]![0]);
    expect(lockQuery).toContain("pg_advisory_xact_lock(hashtext('durable-feed-plan'))");

    const runQuery = staticSql(mocks.execute.mock.calls[1]![0]);
    expect(runQuery).toContain("FOR UPDATE");

    const updateQuery = staticSql(mocks.execute.mock.calls[3]![0]);
    expect(updateQuery).toContain("status = 'failed'");
    expect(updateQuery).toContain("status = 'pending'");
    expect(updateQuery).toContain("sync_run_id =");
    expect(updateQuery).toContain("available_at = NULL");
    expect(updateQuery).toContain("lease_owner = NULL");
    expect(updateQuery).toContain("lease_expires_at = NULL");
    expect(updateQuery).toContain("last_error = 'abandoned: obsolete pre-Task #101 run'");
    expect(updateQuery).not.toContain("feed_snapshots");
    expect(updateQuery).not.toContain("sync_runs SET");
    expect(JSON.stringify(mocks.execute.mock.calls[3]![0])).toContain(RUN_ID);
  });

  it("refuses the run when any step is running", async () => {
    mocks.setResponses([
      [],
      [validRun()],
      [{ id: "running-step", status: "running" }],
    ]);

    await expect(abandonDurableFeedRun(RUN_ID)).rejects.toEqual(
      new DurableFeedRunAbandonError(
        "Durable feed run has running steps and cannot be abandoned",
        409,
      ),
    );

    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["wrong run type", { run_type: "full" }],
    ["wrong architecture", { architecture: "legacy-feed" }],
    ["wrong status", { status: "running" }],
  ])("refuses a run with %s", async (_label, overrides) => {
    mocks.setResponses([[], [validRun(overrides)]]);

    await expect(abandonDurableFeedRun(RUN_ID)).rejects.toBeInstanceOf(
      DurableFeedRunAbandonError,
    );

    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it("does not issue any snapshot or object-storage operation", async () => {
    mocks.setResponses([[], [validRun()], [], [{ id: "pending-1" }]]);

    await abandonDurableFeedRun(RUN_ID);

    const allSql = mocks.execute.mock.calls
      .map((call) => staticSql(call[0]))
      .join("\n");
    expect(allSql).not.toContain("feed_snapshots");
    expect(allSql).not.toContain("storage_path");
    expect(allSql).not.toContain("is_current");
  });
});