import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeChecksum } from "../src/shopify/checksums";

const mocks = vi.hoisted(() => {
  const batchesTable = { name: "feed_export_source_batches" };
  const rowsTable = { name: "feed_export_source_rows" };
  const state = {
    canonicals: [] as Array<Record<string, unknown>>,
    rowInsertBatches: [] as Array<Array<Record<string, unknown>>>,
    failAtRowChunk: null as number | null,
    committed: false,
    rolledBack: false,
  };

  const batch = {
    id: "source-batch-1",
    productIds: ["product-1"],
    sourceMarkets: ["BE_FR"],
    status: "complete",
    rowCount: 0,
    sourceHash: "",
  };

  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    state.committed = false;
    state.rolledBack = false;

    const tx = {
      insert(table: unknown) {
        if (table === batchesTable) {
          return {
            values() {
              return {
                onConflictDoNothing() {
                  return {
                    returning: async () => [batch],
                  };
                },
              };
            },
          };
        }

        if (table === rowsTable) {
          return {
            values: async (values: Array<Record<string, unknown>>) => {
              state.rowInsertBatches.push(values);
              if (
                state.failAtRowChunk !== null &&
                state.rowInsertBatches.length === state.failAtRowChunk
              ) {
                throw new Error("synthetic intermediate chunk failure");
              }
            },
          };
        }

        throw new Error("unexpected table passed to tx.insert");
      },
      update() {
        return {
          set() {
            return {
              where: async () => undefined,
            };
          },
        };
      },
    };

    try {
      const result = await callback(tx);
      state.committed = true;
      return result;
    } catch (error) {
      state.rolledBack = true;
      throw error;
    }
  });

  const select = vi.fn()
    .mockImplementationOnce(() => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      limit: async () => [batch],
    }))
    .mockImplementationOnce(() => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy: async () => state.canonicals.map((canonical, rowIndex) => ({
        id: `source-row-${rowIndex}`,
        rowIndex,
        canonicalJson: canonical,
        checksum: computeChecksum(canonical),
      })),
    }));

  return {
    batchesTable,
    rowsTable,
    state,
    batch,
    db: { transaction, select },
  };
});

vi.mock("@workspace/db", () => ({
  db: mocks.db,
  feedExportSourceBatchesTable: mocks.batchesTable,
  feedExportSourceRowsTable: mocks.rowsTable,
}));

import {
  sourceFingerprintPayload,
  frozenSourceHash,
  getOrCreateFrozenSourceBatch,
  persistFrozenSourceBatch,
} from "../src/jobs/feed-export-source-repository";

function makeCanonicals(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: `canonical-${index}`,
    productId: `product-${index}`,
    variantId: `variant-${index}`,
    market: "BE_FR",
    language: "fr",
    title: `Product ${index}`,
    exclusionReasons: [],
  }));
}

function configureSuccessfulReload(canonicals: Array<Record<string, unknown>>): void {
  mocks.state.canonicals = canonicals;
  mocks.batch.rowCount = canonicals.length;
  mocks.batch.sourceHash = frozenSourceHash(canonicals as never);
  mocks.state.rowInsertBatches = [];
  mocks.state.failAtRowChunk = null;
  mocks.db.select.mockReset();
  mocks.db.select
    .mockImplementationOnce(() => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      limit: async () => [mocks.batch],
    }))
    .mockImplementationOnce(() => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy: async () => canonicals.map((canonical, rowIndex) => ({
        id: `source-row-${rowIndex}`,
        rowIndex,
        canonicalJson: canonical,
        checksum: computeChecksum(canonical),
      })),
    }));
}

describe("persistFrozenSourceBatch", () => {
  beforeEach(() => {
    mocks.state.rowInsertBatches = [];
    mocks.state.failAtRowChunk = null;
    mocks.state.committed = false;
    mocks.state.rolledBack = false;
  });

  it("inserts more than 500 frozen rows in chunks with continuous global row indexes", async () => {
    const canonicals = makeCanonicals(1_001);
    configureSuccessfulReload(canonicals);

    await persistFrozenSourceBatch({
      syncRunId: "run-1",
      channel: "google",
      batchIndex: 0,
      productIds: ["product-1"],
      sourceMarkets: ["BE_FR"],
      canonicals: canonicals as never,
    });

    expect(mocks.state.rowInsertBatches.map((chunk) => chunk.length)).toEqual([500, 500, 1]);
    expect(Math.max(...mocks.state.rowInsertBatches.map((chunk) => chunk.length))).toBeLessThanOrEqual(500);
    expect(mocks.state.rowInsertBatches.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(1_001);
    expect(
      mocks.state.rowInsertBatches.flatMap((chunk) => chunk.map((row) => row.rowIndex)),
    ).toEqual(Array.from({ length: 1_001 }, (_, index) => index));
    expect(mocks.state.committed).toBe(true);
  });

  it("rolls back the transaction when an intermediate frozen-row chunk fails", async () => {
    const canonicals = makeCanonicals(1_001);
    configureSuccessfulReload(canonicals);
    mocks.state.failAtRowChunk = 2;

    await expect(persistFrozenSourceBatch({
      syncRunId: "run-1",
      channel: "google",
      batchIndex: 0,
      productIds: ["product-1"],
      sourceMarkets: ["BE_FR"],
      canonicals: canonicals as never,
    })).rejects.toThrow("synthetic intermediate chunk failure");

    expect(mocks.state.rowInsertBatches.map((chunk) => chunk.length)).toEqual([500, 500]);
    expect(mocks.state.committed).toBe(false);
    expect(mocks.state.rolledBack).toBe(true);
  });
});

describe("sourceFingerprintPayload", () => {
  it("ignores updated_at changes", () => {
    const first = sourceFingerprintPayload({
      id: "row-1",
      quantity: 4,
      updated_at: "2026-08-30T08:00:00.000Z",
    });
    const second = sourceFingerprintPayload({
      id: "row-1",
      quantity: 4,
      updated_at: "2026-08-30T09:00:00.000Z",
    });

    expect(computeChecksum(first)).toBe(computeChecksum(second));
  });

  it.each([
    ["quantity", { quantity: 5 }],
    ["price", { price: "19.99" }],
    ["availability", { available: false }],
    ["translation", { title: "Neuer Titel" }],
    ["image", { url: "https://example.com/new.jpg" }],
  ])("changes when the %s business value changes", (_field, change) => {
    const baseline = sourceFingerprintPayload({
      id: "row-1",
      quantity: 4,
      price: "10.00",
      available: true,
      title: "Titel",
      url: "https://example.com/old.jpg",
      updated_at: "2026-08-30T08:00:00.000Z",
    });
    const changed = sourceFingerprintPayload({
      id: "row-1",
      quantity: 4,
      price: "10.00",
      available: true,
      title: "Titel",
      url: "https://example.com/old.jpg",
      updated_at: "2026-08-30T08:00:00.000Z",
      ...change,
    });

    expect(computeChecksum(changed)).not.toBe(computeChecksum(baseline));
  });
});

describe("getOrCreateFrozenSourceBatch", () => {
  it("returns an existing complete batch without consulting the live source", async () => {
    const canonicals = makeCanonicals(2);
    configureSuccessfulReload(canonicals);
    const createCanonicals = vi.fn();

    const result = await getOrCreateFrozenSourceBatch({
      syncRunId: "run-1",
      channel: "google",
      batchIndex: 0,
      productIds: ["product-1"],
      sourceMarkets: ["BE_FR"],
    }, createCanonicals);

    expect(result.canonicals).toEqual(canonicals);
    expect(createCanonicals).not.toHaveBeenCalled();
  });
});