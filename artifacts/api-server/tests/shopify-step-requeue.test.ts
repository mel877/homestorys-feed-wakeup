import { db, shopifySyncStepsTable, syncRunsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  clearPendingShopifyContentionBackoff,
  requeueFailedShopifyStep,
  ShopifyStepRequeueError,
} from "../src/jobs/shopify-sync-step-repository";

const INVENTORY_CONTENTION_ERROR =
  "Cannot create inventory bulk operation: an unrelated Shopify bulk operation is active";

describe("targeted Shopify step recovery", () => {
  it("clears only pending inventory contention backoff and preserves durable state", async () => {
    const [run] = await db.insert(syncRunsTable).values({
      runType: "full",
      status: "failed",
      metadata: {
        architecture: "durable-shopify",
        nightlyCycleKey: "2026-08-29",
        failureReason: "mandatory Shopify step failed",
      },
    }).returning({ id: syncRunsTable.id });
    const runId = run!.id;

    try {
      await db.insert(shopifySyncStepsTable).values([
        {
          syncRunId: runId,
          phase: "products",
          sequence: 0,
          batchIndex: 0,
          status: "completed",
          attempts: 4,
          completedAt: new Date(),
        },
        {
          syncRunId: runId,
          phase: "pricing",
          sequence: 1,
          batchIndex: 0,
          status: "completed",
          attempts: 7,
          completedAt: new Date(),
        },
        {
          syncRunId: runId,
          phase: "inventory",
          sequence: 2,
          batchIndex: 0,
          status: "pending",
          attempts: 8,
          availableAt: new Date("2099-01-01T00:00:00.000Z"),
          lastError: INVENTORY_CONTENTION_ERROR,
        },
      ]);

      const beforeSteps = await db.select()
        .from(shopifySyncStepsTable)
        .where(eq(shopifySyncStepsTable.syncRunId, runId));
      const before = beforeSteps.find((step) => step.phase === "inventory");

      const result = await clearPendingShopifyContentionBackoff({
        sourceSyncRunId: runId,
        step: "inventory",
      });

      const [after] = await db.select()
        .from(shopifySyncStepsTable)
        .where(eq(shopifySyncStepsTable.id, before!.id));
      const [storedRun] = await db.select()
        .from(syncRunsTable)
        .where(eq(syncRunsTable.id, runId));

      expect(result).toMatchObject({
        sourceSyncRunId: runId,
        step: "inventory",
        stepId: before!.id,
        status: "pending",
        attempts: 8,
      });
      expect(after).toMatchObject({
        status: "pending",
        attempts: 8,
        lastError: INVENTORY_CONTENTION_ERROR,
        cursor: null,
        checkpoint: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(after!.availableAt!.getTime()).toBeLessThan(before!.availableAt!.getTime());
      expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());

      const {
        availableAt: _beforeAvailableAt,
        updatedAt: _beforeUpdatedAt,
        ...beforePreserved
      } = before!;
      const {
        availableAt: _afterAvailableAt,
        updatedAt: _afterUpdatedAt,
        ...afterPreserved
      } = after!;
      expect(afterPreserved).toEqual(beforePreserved);
      expect(storedRun).toMatchObject({
        id: runId,
        status: "failed",
        metadata: expect.objectContaining({
          architecture: "durable-shopify",
          nightlyCycleKey: "2026-08-29",
          failureReason: "mandatory Shopify step failed",
        }),
      });
    } finally {
      await db.delete(syncRunsTable).where(eq(syncRunsTable.id, runId));
    }
  });

  it("rejects pending inventory without the exact contention error", async () => {
    const [run] = await db.insert(syncRunsTable).values({
      runType: "full",
      status: "failed",
      metadata: { architecture: "durable-shopify", nightlyCycleKey: "test-contention-error" },
    }).returning({ id: syncRunsTable.id });
    const runId = run!.id;

    try {
      await db.insert(shopifySyncStepsTable).values([
        {
          syncRunId: runId,
          phase: "products",
          sequence: 0,
          batchIndex: 0,
          status: "completed",
        },
        {
          syncRunId: runId,
          phase: "pricing",
          sequence: 1,
          batchIndex: 0,
          status: "completed",
        },
        {
          syncRunId: runId,
          phase: "inventory",
          sequence: 2,
          batchIndex: 0,
          status: "pending",
          attempts: 8,
          availableAt: new Date("2099-01-01T00:00:00.000Z"),
          lastError: "another error",
        },
      ]);

      await expect(clearPendingShopifyContentionBackoff({
        sourceSyncRunId: runId,
        step: "inventory",
      })).rejects.toMatchObject({
        name: "ShopifyStepRequeueError",
        statusCode: 409,
      });
    } finally {
      await db.delete(syncRunsTable).where(eq(syncRunsTable.id, runId));
    }
  });

  it("requeues only failed inventory and preserves products and pricing", async () => {
    const [run] = await db.insert(syncRunsTable).values({
      runType: "full",
      status: "failed",
      metadata: {
        architecture: "durable-shopify",
        nightlyCycleKey: "2026-08-29",
        failureReason: "mandatory Shopify step failed",
      },
    }).returning({ id: syncRunsTable.id });
    const runId = run!.id;

    try {
      await db.insert(shopifySyncStepsTable).values([
        {
          syncRunId: runId,
          phase: "products",
          sequence: 0,
          batchIndex: 0,
          status: "completed",
          attempts: 4,
          completedAt: new Date(),
        },
        {
          syncRunId: runId,
          phase: "pricing",
          sequence: 1,
          batchIndex: 0,
          status: "completed",
          attempts: 7,
          completedAt: new Date(),
        },
        {
          syncRunId: runId,
          phase: "inventory",
          sequence: 2,
          batchIndex: 0,
          status: "failed",
          attempts: 5,
          lastError: "Cannot create inventory bulk operation: an unrelated Shopify bulk operation is active",
        },
        ...(["translations", "images", "completion"] as const).map((phase, index) => ({
          syncRunId: runId,
          phase,
          sequence: index + 3,
          batchIndex: 0,
          status: "pending" as const,
          attempts: 0,
        })),
      ]);

      const result = await requeueFailedShopifyStep({
        sourceSyncRunId: runId,
        step: "inventory",
      });

      const steps = await db.select({
        phase: shopifySyncStepsTable.phase,
        status: shopifySyncStepsTable.status,
        attempts: shopifySyncStepsTable.attempts,
        lastError: shopifySyncStepsTable.lastError,
        cursor: shopifySyncStepsTable.cursor,
        checkpoint: shopifySyncStepsTable.checkpoint,
      }).from(shopifySyncStepsTable)
        .where(eq(shopifySyncStepsTable.syncRunId, runId));
      const [storedRun] = await db.select({
        status: syncRunsTable.status,
        metadata: syncRunsTable.metadata,
      }).from(syncRunsTable)
        .where(eq(syncRunsTable.id, runId));
      const byPhase = new Map(steps.map((step) => [step.phase, step]));

      expect(result).toMatchObject({
        sourceSyncRunId: runId,
        step: "inventory",
        status: "pending",
        attempts: 0,
      });
      expect(byPhase.get("products")).toMatchObject({ status: "completed", attempts: 4 });
      expect(byPhase.get("pricing")).toMatchObject({ status: "completed", attempts: 7 });
      expect(byPhase.get("inventory")).toMatchObject({
        status: "pending",
        attempts: 0,
        lastError: null,
        cursor: null,
        checkpoint: null,
      });
      expect(storedRun).toMatchObject({
        status: "failed",
        metadata: expect.objectContaining({
          architecture: "durable-shopify",
          nightlyCycleKey: "2026-08-29",
          failureReason: "mandatory Shopify step failed",
        }),
      });
    } finally {
      await db.delete(syncRunsTable).where(eq(syncRunsTable.id, runId));
    }
  });

  it("rejects a completed inventory step", async () => {
    const [run] = await db.insert(syncRunsTable).values({
      runType: "full",
      status: "completed",
      metadata: { architecture: "durable-shopify", nightlyCycleKey: "test-completed" },
    }).returning({ id: syncRunsTable.id });
    const runId = run!.id;

    try {
      await db.insert(shopifySyncStepsTable).values({
        syncRunId: runId,
        phase: "inventory",
        sequence: 2,
        batchIndex: 0,
        status: "completed",
        attempts: 1,
        completedAt: new Date(),
      });

      await expect(requeueFailedShopifyStep({
        sourceSyncRunId: runId,
        step: "inventory",
      })).rejects.toMatchObject({
        name: "ShopifyStepRequeueError",
        statusCode: 409,
      });
    } finally {
      await db.delete(syncRunsTable).where(eq(syncRunsTable.id, runId));
    }
  });

  it("rejects a failed inventory step with an unsafe checkpoint", async () => {
    const [run] = await db.insert(syncRunsTable).values({
      runType: "full",
      status: "failed",
      metadata: { architecture: "durable-shopify", nightlyCycleKey: "test-unsafe" },
    }).returning({ id: syncRunsTable.id });
    const runId = run!.id;

    try {
      await db.insert(shopifySyncStepsTable).values([
        {
          syncRunId: runId,
          phase: "products",
          sequence: 0,
          batchIndex: 0,
          status: "completed",
          attempts: 1,
          completedAt: new Date(),
        },
        {
          syncRunId: runId,
          phase: "pricing",
          sequence: 1,
          batchIndex: 0,
          status: "completed",
          attempts: 1,
          completedAt: new Date(),
        },
        {
          syncRunId: runId,
          phase: "inventory",
          sequence: 2,
          batchIndex: 0,
          status: "failed",
          attempts: 2,
          checkpoint: { stage: "polling", operationId: "bulk-1" },
        },
      ]);

      await expect(requeueFailedShopifyStep({
        sourceSyncRunId: runId,
        step: "inventory",
      })).rejects.toMatchObject({
        name: "ShopifyStepRequeueError",
        statusCode: 409,
      });
    } finally {
      await db.delete(syncRunsTable).where(eq(syncRunsTable.id, runId));
    }
  });
});