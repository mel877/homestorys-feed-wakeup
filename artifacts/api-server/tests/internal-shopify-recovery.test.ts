import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const mocks = vi.hoisted(() => {
  class MockShopifyStepRequeueError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode = 409) {
      super(message);
      this.name = "ShopifyStepRequeueError";
      this.statusCode = statusCode;
    }
  }

  return {
    clearPendingShopifyContentionBackoff: vi.fn(),
    requeueFailedShopifyStep: vi.fn(),
    ShopifyStepRequeueError: MockShopifyStepRequeueError,
  };
});

process.env["INTERNAL_API_SECRET"] = "shopify-recovery-test-secret";

vi.mock("../src/jobs/shopify-sync-step-repository", () => mocks);

async function buildApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("../src/routes/shopify-recovery");
  app.use("/api/internal", router);
  return app;
}

let app: Express;
beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  mocks.clearPendingShopifyContentionBackoff.mockReset();
  mocks.clearPendingShopifyContentionBackoff.mockResolvedValue({
    sourceSyncRunId: "b096d776-af60-47a6-bffe-5c824ef1985e",
    step: "inventory",
    stepId: "inventory-step",
    status: "pending",
    attempts: 8,
  });
  mocks.requeueFailedShopifyStep.mockReset();
  mocks.requeueFailedShopifyStep.mockResolvedValue({
    sourceSyncRunId: "b096d776-af60-47a6-bffe-5c824ef1985e",
    step: "inventory",
    stepId: "inventory-step",
    status: "pending",
    attempts: 0,
  });
});

describe("POST /api/internal/shopify/clear-contention-backoff", () => {
  const validBody = {
    sourceSyncRunId: "b096d776-af60-47a6-bffe-5c824ef1985e",
    step: "inventory",
  };

  it("requires the internal API secret", async () => {
    const res = await request(app)
      .post("/api/internal/shopify/clear-contention-backoff")
      .send(validBody);

    expect(res.status).toBe(401);
    expect(mocks.clearPendingShopifyContentionBackoff).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies and non-inventory steps", async () => {
    for (const body of [
      {},
      { ...validBody, step: "products" },
      { ...validBody, extra: true },
      { ...validBody, sourceSyncRunId: "not-a-uuid" },
    ]) {
      const res = await request(app)
        .post("/api/internal/shopify/clear-contention-backoff")
        .set("Authorization", "Bearer shopify-recovery-test-secret")
        .send(body);

      expect(res.status).toBe(400);
    }
    expect(mocks.clearPendingShopifyContentionBackoff).not.toHaveBeenCalled();
  });

  it("clears only the requested pending inventory contention backoff", async () => {
    const res = await request(app)
      .post("/api/internal/shopify/clear-contention-backoff")
      .set("Authorization", "Bearer shopify-recovery-test-secret")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "backoff-cleared",
      sourceSyncRunId: validBody.sourceSyncRunId,
      step: "inventory",
      stepStatus: "pending",
      attempts: 8,
    });
    expect(mocks.clearPendingShopifyContentionBackoff).toHaveBeenCalledWith(validBody);
  });

  it("returns a conflict when the pending step is not safe to accelerate", async () => {
    mocks.clearPendingShopifyContentionBackoff.mockRejectedValueOnce(
      new mocks.ShopifyStepRequeueError("Only the exact pending inventory contention backoff can be cleared"),
    );

    const res = await request(app)
      .post("/api/internal/shopify/clear-contention-backoff")
      .set("Authorization", "Bearer shopify-recovery-test-secret")
      .send(validBody);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: "error" });
  });
});

describe("POST /api/internal/shopify/requeue-step", () => {
  const validBody = {
    sourceSyncRunId: "b096d776-af60-47a6-bffe-5c824ef1985e",
    step: "inventory",
  };

  it("requires the internal API secret", async () => {
    const res = await request(app)
      .post("/api/internal/shopify/requeue-step")
      .send(validBody);

    expect(res.status).toBe(401);
    expect(mocks.requeueFailedShopifyStep).not.toHaveBeenCalled();
  });

  it("rejects an invalid internal API secret", async () => {
    const res = await request(app)
      .post("/api/internal/shopify/requeue-step")
      .set("Authorization", "Bearer wrong-secret")
      .send(validBody);

    expect(res.status).toBe(403);
    expect(mocks.requeueFailedShopifyStep).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies and non-inventory steps", async () => {
    for (const body of [
      {},
      { ...validBody, step: "pricing" },
      { ...validBody, extra: true },
      { ...validBody, sourceSyncRunId: "not-a-uuid" },
    ]) {
      const res = await request(app)
        .post("/api/internal/shopify/requeue-step")
        .set("Authorization", "Bearer shopify-recovery-test-secret")
        .send(body);

      expect(res.status).toBe(400);
    }
    expect(mocks.requeueFailedShopifyStep).not.toHaveBeenCalled();
  });

  it("requeues exactly the requested source run inventory step", async () => {
    const res = await request(app)
      .post("/api/internal/shopify/requeue-step")
      .set("Authorization", "Bearer shopify-recovery-test-secret")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "requeued",
      sourceSyncRunId: validBody.sourceSyncRunId,
      step: "inventory",
      attempts: 0,
    });
    expect(mocks.requeueFailedShopifyStep).toHaveBeenCalledWith(validBody);
  });

  it("returns a conflict for a completed or unsafe step", async () => {
    mocks.requeueFailedShopifyStep.mockRejectedValueOnce(
      new mocks.ShopifyStepRequeueError("Only a failed inventory step with an empty checkpoint can be requeued"),
    );

    const res = await request(app)
      .post("/api/internal/shopify/requeue-step")
      .set("Authorization", "Bearer shopify-recovery-test-secret")
      .send(validBody);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: "error" });
  });

  it("returns not found without exposing or mutating another run", async () => {
    mocks.requeueFailedShopifyStep.mockRejectedValueOnce(
      new mocks.ShopifyStepRequeueError("Shopify sync run was not found", 404),
    );

    const res = await request(app)
      .post("/api/internal/shopify/requeue-step")
      .set("Authorization", "Bearer shopify-recovery-test-secret")
      .send(validBody);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: "error" });
  });
});