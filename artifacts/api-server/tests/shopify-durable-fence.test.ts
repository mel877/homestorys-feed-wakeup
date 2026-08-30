import {
  db,
  shopifySyncStepsTable,
  syncRunsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { commitShopifySyncUnit } from "../src/jobs/shopify-sync-step-repository";

function fakeDatabase({ lease = true }: { lease?: boolean | "expires" } = {}) {
  const state = { writes: 0, cursor: null as unknown, checkpoint: null as unknown };
  return {
    state,
    transaction: async (work: (tx: { execute: (query: unknown) => Promise<{ rows: unknown[] }> }) => Promise<void>) => {
      const before = { ...state };
      let executeCount = 0;
      const tx = {
        async execute(_query: unknown) {
          executeCount++;
          if (executeCount === 1) return { rows: lease ? [{ id: "step-1" }] : [] };
          if (executeCount === 2) {
            if (lease !== true) return { rows: [] };
            state.cursor = { byteOffset: 42 };
            state.checkpoint = { stage: "batches" };
            return { rows: [{ id: "step-1" }] };
          }
          return { rows: [] };
        },
      };
      try {
        await work(tx);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    },
  };
}

describe("Shopify durable transaction fence", () => {
  it("commits a business write and cursor/checkpoint together", async () => {
    const database = fakeDatabase();
    await commitShopifySyncUnit({
      stepId: "step-1", workerId: "worker-1",
      cursor: { byteOffset: 42 }, checkpoint: { stage: "batches" },
      database,
      writer: async () => { database.state.writes++; },
    });
    expect(database.state).toEqual({
      writes: 1, cursor: { byteOffset: 42 }, checkpoint: { stage: "batches" },
    });
  });

  it("rolls back both business data and progress when the writer fails", async () => {
    const database = fakeDatabase();
    await expect(commitShopifySyncUnit({
      stepId: "step-1", workerId: "worker-1", cursor: { byteOffset: 42 },
      database,
      writer: async () => { database.state.writes++; throw new Error("writer failed"); },
    })).rejects.toThrow("writer failed");
    expect(database.state).toEqual({ writes: 0, cursor: null, checkpoint: null });
  });

  it("does not write or advance progress when the lease is lost", async () => {
    const database = fakeDatabase({ lease: false });
    await expect(commitShopifySyncUnit({
      stepId: "step-1", workerId: "worker-1", cursor: { byteOffset: 42 },
      database, writer: async () => { database.state.writes++; },
    })).rejects.toThrow("lease");
    expect(database.state).toEqual({ writes: 0, cursor: null, checkpoint: null });
  });

  it("rolls back the writer when the lease expires before progress is updated", async () => {
    const database = fakeDatabase({ lease: "expires" });
    await expect(commitShopifySyncUnit({
      stepId: "step-1", workerId: "worker-1", cursor: { byteOffset: 42 },
      database, writer: async () => { database.state.writes++; },
    })).rejects.toThrow("lease");
    expect(database.state).toEqual({ writes: 0, cursor: null, checkpoint: null });
  });

  it("uses wall-clock time after a slow writer and rolls back its business write", async () => {
    const [run] = await db.insert(syncRunsTable).values({
      runType: "full",
      status: "running",
      metadata: { durableFenceTest: true },
    }).returning({ id: syncRunsTable.id });
    const workerId = `fence-test-${run!.id}`;
    const [step] = await db.insert(shopifySyncStepsTable).values({
      syncRunId: run!.id,
      phase: "products",
      sequence: 0,
      batchIndex: 0,
      status: "running",
      attempts: 1,
      leaseOwner: workerId,
      leaseExpiresAt: new Date(Date.now() + 1_000),
    }).returning({ id: shopifySyncStepsTable.id });

    try {
      await expect(commitShopifySyncUnit({
        stepId: step!.id,
        workerId,
        cursor: { byteOffset: 42 },
        writer: async (tx: any) => {
          await tx.update(syncRunsTable)
            .set({ metadata: { durableFenceTest: true, businessWrite: true } })
            .where(eq(syncRunsTable.id, run!.id));
          await tx.execute(sql`SELECT pg_sleep(1.2)`);
        },
      })).rejects.toThrow("lease");

      const [storedRun] = await db.select({ metadata: syncRunsTable.metadata })
        .from(syncRunsTable)
        .where(eq(syncRunsTable.id, run!.id));
      const [storedStep] = await db.select({ cursor: shopifySyncStepsTable.cursor })
        .from(shopifySyncStepsTable)
        .where(eq(shopifySyncStepsTable.id, step!.id));
      expect(storedRun?.metadata).toEqual({ durableFenceTest: true });
      expect(storedStep?.cursor).toBeNull();
    } finally {
      await db.delete(syncRunsTable).where(eq(syncRunsTable.id, run!.id));
    }
  }, 10_000);
});