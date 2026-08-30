import { describe, expect, it, vi } from "vitest";
import { readBulkJsonlSlice } from "../src/shopify/bulk-ops";

const response = (text: string, status = 206) => {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  const cancel = vi.fn();
  return {
    status, ok: status >= 200 && status < 300,
    body: {
      getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }),
        cancel, releaseLock: () => undefined,
      }),
    },
    cancel,
  };
};

describe("bounded Shopify Bulk JSONL reader", () => {
  it("does not fetch when the budget is already exhausted", async () => {
    const fetcher = vi.fn();
    const result = await readBulkJsonlSlice("https://bulk.test/file", {
      shouldContinue: () => false, fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toEqual({ lines: [], nextOffset: 0, eof: false });
  });
  it("stops at its limit without consuming the whole response and returns a byte checkpoint", async () => {
    const first = response('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n', 200);
    const fetcher = vi.fn().mockResolvedValue(first);
    const result = await readBulkJsonlSlice<{ id: string }>("https://bulk.test/file", {
      offset: 0, maxLines: 1, fetcher,
    });
    expect(result.lines.map((line) => line.value.id)).toEqual(["a"]);
    expect(result.nextOffset).toBe(new TextEncoder().encode('{"id":"a"}\n').byteLength);
    expect(first.cancel).toHaveBeenCalled();
  });

  it("uses the persisted byte offset to resume without replaying committed lines", async () => {
    const offset = new TextEncoder().encode('{"id":"a"}\n').byteLength;
    const fetcher = vi.fn().mockResolvedValue(response('{"id":"b"}\n{"id":"c"}\n'));
    const result = await readBulkJsonlSlice<{ id: string }>("https://bulk.test/file", {
      offset, maxLines: 1, fetcher,
    });
    expect(fetcher).toHaveBeenCalledWith("https://bulk.test/file", expect.objectContaining({
      headers: { Range: `bytes=${offset}-` },
    }));
    expect(result.lines[0]).toMatchObject({ value: { id: "b" }, startOffset: offset });
  });

  it("requires a partial response when resuming", async () => {
    await expect(readBulkJsonlSlice("https://bulk.test/file", {
      offset: 5, fetcher: vi.fn().mockResolvedValue(response('{"id":"b"}\n', 200)),
    })).rejects.toThrow("206");
  });

  it("returns a final valid JSON line without a trailing newline", async () => {
    const result = await readBulkJsonlSlice<{ id: string }>("https://bulk.test/file", {
      fetcher: vi.fn().mockResolvedValue(response('{"id":"last"}', 200)),
    });
    expect(result.lines).toEqual([expect.objectContaining({
      value: { id: "last" }, startOffset: 0, endOffset: 13,
    })]);
  });
});