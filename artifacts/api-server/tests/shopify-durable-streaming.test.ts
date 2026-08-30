import { describe, expect, it, vi } from "vitest";
import { readDurableProductGroups } from "../src/shopify/sync-products";
import { readDurableInventoryGroups } from "../src/shopify/sync-inventory";

const bulk = (text: string, status = 200) => {
  const bytes = new TextEncoder().encode(text);
  let read = false;
  return { status, body: { getReader: () => ({
    read: async () => read ? { done: true } : (read = true, { done: false, value: bytes }),
    cancel: vi.fn(), releaseLock() {},
  }) } };
};

describe("durable Shopify bulk grouping", () => {
  it("returns only complete product parents and resumes at the next parent byte", async () => {
    const text = '{"id":"gid://shopify/Product/1"}\n{"id":"gid://shopify/ProductVariant/1","__parentId":"gid://shopify/Product/1"}\n{"id":"gid://shopify/Product/2"}\n';
    const fetcher = vi.fn().mockResolvedValue(bulk(text));
    const first = await readDurableProductGroups("https://bulk.test", { fetcher, maxLines: 3 });
    expect(first.groups).toHaveLength(1);
    expect(first.nextByteOffset).toBe(new TextEncoder().encode(text).byteLength);
    const secondFetch = vi.fn().mockResolvedValue(bulk("", 206));
    const second = await readDurableProductGroups("https://bulk.test", {
      byteOffset: first.nextByteOffset, pendingGroup: first.pendingGroup, fetcher: secondFetch, maxLines: 3,
    });
    expect(secondFetch).toHaveBeenCalledWith("https://bulk.test", expect.objectContaining({ headers: { Range: `bytes=${first.nextByteOffset}-` } }));
    expect(second.groups[0]!.parent.id).toContain("/Product/2");
  });

  it("does not commit an incomplete inventory parent when budget stops", async () => {
    const text = '{"id":"gid://shopify/InventoryItem/1"}\n{"id":"level","__parentId":"gid://shopify/InventoryItem/1","quantities":[],"location":{}}\n';
    const result = await readDurableInventoryGroups("https://bulk.test", {
      fetcher: vi.fn().mockResolvedValue(bulk(text)),
      shouldContinue: () => false,
    });
    expect(result.groups).toEqual([]);
    expect(result.nextByteOffset).toBe(0);
  });

  it("persists a split product parent and resumes it at the consumed byte offset", async () => {
    const firstText = '{"id":"gid://shopify/Product/1"}\n{"id":"gid://shopify/ProductVariant/1","__parentId":"gid://shopify/Product/1"}\n';
    const first = await readDurableProductGroups("https://bulk.test", {
      fetcher: vi.fn().mockResolvedValue(bulk(firstText)),
      maxLines: 1,
    });
    expect(first.groups).toEqual([]);
    expect(first.pendingGroup).toBeDefined();
    expect(first.nextByteOffset).toBe(firstText.indexOf('{"id":"gid://shopify/ProductVariant'));
    const fetcher = vi.fn().mockResolvedValue(bulk('{"id":"gid://shopify/ProductVariant/1","__parentId":"gid://shopify/Product/1"}\n{"id":"gid://shopify/Product/2"}\n', 206));
    const second = await readDurableProductGroups("https://bulk.test", {
      byteOffset: first.nextByteOffset, pendingGroup: first.pendingGroup, fetcher, maxLines: 2,
    });
    expect(fetcher).toHaveBeenCalledWith("https://bulk.test", expect.objectContaining({ headers: { Range: `bytes=${first.nextByteOffset}-` } }));
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0]!.parent.id).toContain("/Product/1");
  });
});