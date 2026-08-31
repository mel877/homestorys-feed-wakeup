import { describe, expect, it } from "vitest";
import {
  decideCurrentBulkOperation,
  type CurrentBulkOperationDecision,
} from "../src/shopify/bulk-ops";
import { BULK_INVENTORY_QUERY } from "../src/shopify/sync-inventory";
import { BULK_PRODUCTS_QUERY } from "../src/shopify/sync-products";

function operation(
  status: "CREATED" | "RUNNING" | "COMPLETED" | "CANCELING" | "CANCELED" | "FAILED" | "EXPIRED",
  query: string,
) {
  return {
    id: `gid://shopify/BulkOperation/${status}`,
    status,
    query,
    errorCode: null,
    url: null,
    objectCount: "0",
    fileSize: null,
    createdAt: "2026-08-31T00:00:00Z",
    completedAt: null,
  };
}

describe("current Shopify bulk-operation contention", () => {
  it.each([
    ["products", BULK_PRODUCTS_QUERY],
    ["inventory", BULK_INVENTORY_QUERY],
  ])("does not block %s for a mismatched completed operation", (_phase, expectedQuery) => {
    expect(
      decideCurrentBulkOperation(
        operation("COMPLETED", "query for a different operation"),
        expectedQuery,
      ),
    ).toBe<CurrentBulkOperationDecision>("create");
  });

  it.each([
    "CREATED",
    "RUNNING",
    "CANCELING",
  ] as const)("blocks a mismatched %s operation", (status) => {
    expect(
      decideCurrentBulkOperation(
        operation(status, "query for a different operation"),
        BULK_INVENTORY_QUERY,
      ),
    ).toBe<CurrentBulkOperationDecision>("block");
  });

  it.each([
    "COMPLETED",
    "CANCELED",
    "FAILED",
    "EXPIRED",
  ] as const)("ignores a mismatched terminal %s operation", (status) => {
    expect(
      decideCurrentBulkOperation(
        operation(status, "query for a different operation"),
        BULK_PRODUCTS_QUERY,
      ),
    ).toBe<CurrentBulkOperationDecision>("create");
  });

  it.each([
    "CREATED",
    "RUNNING",
    "COMPLETED",
    "CANCELING",
    "CANCELED",
    "FAILED",
    "EXPIRED",
  ] as const)("adopts a matching %s operation for create-gap recovery", (status) => {
    expect(
      decideCurrentBulkOperation(
        operation(status, BULK_INVENTORY_QUERY),
        BULK_INVENTORY_QUERY,
      ),
    ).toBe<CurrentBulkOperationDecision>("adopt");
  });

  it("creates when Shopify has no current operation", () => {
    expect(decideCurrentBulkOperation(null, BULK_INVENTORY_QUERY))
      .toBe<CurrentBulkOperationDecision>("create");
  });
});