/**
 * A feed safety gate must not acknowledge the Shopify webhook that triggered
 * it. Otherwise the changed product may never reach the public catalog.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPublishProductChanges,
  mockSyncProduct,
  mockSet,
  MockPublicationBlockedError,
} = vi.hoisted(() => ({
  mockPublishProductChanges: vi.fn(),
  mockSyncProduct: vi.fn(),
  mockSet: vi.fn(),
  MockPublicationBlockedError: class IncrementalFeedPublicationBlockedError extends Error {},
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ id: "product-db-id" }]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: mockSet,
    })),
  },
  webhookEventsTable: { id: "id" },
  productsTable: { id: "id", shopifyGid: "shopifyGid" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  sql: (parts: TemplateStringsArray) => parts.join(""),
}));

vi.mock("../src/shopify/index", () => ({
  syncProduct: mockSyncProduct,
  updateInventoryItem: vi.fn(),
}));

vi.mock("../src/exporters/incremental-publisher", () => ({
  IncrementalFeedPublicationBlockedError: MockPublicationBlockedError,
  publishProductChanges: mockPublishProductChanges,
}));

vi.mock("../src/shopify/client", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockSyncProduct.mockResolvedValue("sync-run");
  mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
});

describe("WebhookWorker feed publication failures", () => {
  it("keeps a blocked product reconciliation pending for retry instead of marking it processed", async () => {
    mockPublishProductChanges.mockRejectedValueOnce(
      new MockPublicationBlockedError("One or more incremental public URL feeds were blocked"),
    );

    const { WebhookWorker } = await import("../src/jobs/webhook-worker");
    const worker = new WebhookWorker();
    const processEvent = (worker as unknown as {
      processEvent: (event: {
        id: string;
        topic: string;
        payload: Record<string, unknown>;
        retry_count: number;
      }) => Promise<void>;
    }).processEvent.bind(worker);

    await processEvent({
      id: "event-1",
      topic: "products/update",
      payload: { id: 12345 },
      retry_count: 4,
    });

    expect(mockSyncProduct).toHaveBeenCalledWith("12345");
    expect(mockPublishProductChanges).toHaveBeenCalledWith(["product-db-id"]);
    expect(mockSet).toHaveBeenCalledOnce();
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      status: "pending",
      retryCount: 0,
      error: expect.stringContaining("blocked"),
      retryAfter: expect.any(Date),
    }));
    expect(mockSet).not.toHaveBeenCalledWith(expect.objectContaining({ status: "processed" }));
  });
});