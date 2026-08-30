import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.fn().mockResolvedValue([]);
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => selectRows()) })),
    },
  };
});

import { syncProducts } from "../src/shopify/sync-products";
import { syncInventory } from "../src/shopify/sync-inventory";

const tracker = {
  bumpApiCalls: vi.fn(), bumpRead: vi.fn(), bumpCreated: vi.fn(),
  bumpChanged: vi.fn(), bumpDeleted: vi.fn(), checkpoint: vi.fn(),
  getStats: vi.fn(() => ({})),
} as never;

function eofResponse(line: string) {
  let index = 0;
  const bytes = new TextEncoder().encode(`${line}\n`);
  return {
    status: 200,
    body: { getReader: () => ({
      read: async () => index++ === 0 ? { done: false, value: bytes } : { done: true },
      cancel: vi.fn(), releaseLock() {},
    }) },
  };
}

describe("durable Shopify EOF finalization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fences product archive finalization once with finalized cursor", async () => {
    const commitUnit = vi.fn(async (_cursor, _writer) => {});
    const result = await syncProducts({} as never, tracker, {
      bulkResultUrl: "https://bulk.test/products", byteOffset: 0,
      fetcher: vi.fn().mockResolvedValue(eofResponse(JSON.stringify({
        id: "gid://shopify/Product/1", title: "One", handle: "one",
        status: "ACTIVE", tags: [],
      }))),
      commitUnit,
    });
    expect(result.completed).toBe(true);
    expect(commitUnit).toHaveBeenLastCalledWith(
      expect.objectContaining({ finalized: true }),
      expect.any(Function),
    );
  });

  it("does not parse or finalize products again after finalized cursor", async () => {
    const fetcher = vi.fn();
    const commitUnit = vi.fn();
    const result = await syncProducts({} as never, tracker, {
      bulkResultUrl: "https://bulk.test/products", byteOffset: 42,
      finalized: true, fetcher, commitUnit,
    });
    expect(result.completed).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(commitUnit).not.toHaveBeenCalled();
  });

  it("fences inventory availability finalization once and skips it after resume", async () => {
    const commitUnit = vi.fn(async (_cursor, _writer) => {});
    const fetcher = vi.fn().mockResolvedValue(eofResponse(JSON.stringify({
      id: "gid://shopify/InventoryItem/1", sku: null, variant: null,
    })));
    const result = await syncInventory({} as never, tracker, {
      bulkResultUrl: "https://bulk.test/inventory", fetcher, commitUnit,
    });
    expect(result.completed).toBe(true);
    expect(commitUnit).toHaveBeenLastCalledWith(
      expect.objectContaining({ finalized: true }),
      expect.any(Function),
    );

    const resumedFetch = vi.fn();
    await syncInventory({} as never, tracker, {
      bulkResultUrl: "https://bulk.test/inventory", byteOffset: 42,
      finalized: true, fetcher: resumedFetch, commitUnit,
    });
    expect(resumedFetch).not.toHaveBeenCalled();
  });
});