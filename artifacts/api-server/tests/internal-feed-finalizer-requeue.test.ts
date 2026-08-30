import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const mocks = vi.hoisted(() => {
  class MockFeedFinalizerRequeueCardinalityError extends Error {
    readonly matched: number;

    constructor(matched: number) {
      super(`Expected exactly 9 blocked Meta finalizer steps, found ${matched}`);
      this.name = "FeedFinalizerRequeueCardinalityError";
      this.matched = matched;
    }
  }

  return {
    requeueBlockedMetaFinalizers: vi.fn(),
    FeedFinalizerRequeueCardinalityError: MockFeedFinalizerRequeueCardinalityError,
  };
});

process.env["INTERNAL_API_SECRET"] = "requeue-test-secret";

vi.mock("../src/jobs/feed-export-step-repository", () => mocks);

import { FeedFinalizerRequeueCardinalityError } from "../src/jobs/feed-export-step-repository";

async function buildApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("../src/routes/feed-finalizers");
  app.use("/api/internal", router);
  return app;
}

let app: Express;
beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  mocks.requeueBlockedMetaFinalizers.mockReset();
  mocks.requeueBlockedMetaFinalizers.mockResolvedValue({
    count: 9,
    targets: [
      { id: "step-1", marketCode: "BASE", language: "", batchIndex: 0 },
    ],
  });
});

describe("POST /api/internal/feed-finalizers/requeue", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await request(app)
      .post("/api/internal/feed-finalizers/requeue")
      .send({ syncRunId: "26f87a65-9830-44f2-9d39-67c0b4e5eee8" });

    expect(res.status).toBe(401);
    expect(mocks.requeueBlockedMetaFinalizers).not.toHaveBeenCalled();
  });

  it("rejects an invalid secret", async () => {
    const res = await request(app)
      .post("/api/internal/feed-finalizers/requeue")
      .set("Authorization", "Bearer wrong")
      .send({ syncRunId: "26f87a65-9830-44f2-9d39-67c0b4e5eee8" });

    expect(res.status).toBe(403);
    expect(mocks.requeueBlockedMetaFinalizers).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { syncRunId: "not-a-uuid" },
    {
      syncRunId: "26f87a65-9830-44f2-9d39-67c0b4e5eee8",
      extra: true,
    },
  ])("rejects an invalid body: %j", async (body) => {
    const res = await request(app)
      .post("/api/internal/feed-finalizers/requeue")
      .set("Authorization", "Bearer requeue-test-secret")
      .send(body);

    expect(res.status).toBe(400);
    expect(mocks.requeueBlockedMetaFinalizers).not.toHaveBeenCalled();
  });

  it("returns success for exactly nine requeued finalizers", async () => {
    const syncRunId = "26f87a65-9830-44f2-9d39-67c0b4e5eee8";

    const res = await request(app)
      .post("/api/internal/feed-finalizers/requeue")
      .set("Authorization", "Bearer requeue-test-secret")
      .send({ syncRunId });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "requeued", count: 9 });
    expect(mocks.requeueBlockedMetaFinalizers).toHaveBeenCalledWith(syncRunId);
  });

  it("returns an explicit conflict when the cardinality guard rolls back", async () => {
    mocks.requeueBlockedMetaFinalizers.mockRejectedValueOnce(
      new FeedFinalizerRequeueCardinalityError(8),
    );

    const res = await request(app)
      .post("/api/internal/feed-finalizers/requeue")
      .set("Authorization", "Bearer requeue-test-secret")
      .send({ syncRunId: "26f87a65-9830-44f2-9d39-67c0b4e5eee8" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      status: "error",
      matched: 8,
      expected: 9,
    });
  });

  it("does not invoke any build or pump operation", async () => {
    const res = await request(app)
      .post("/api/internal/feed-finalizers/requeue")
      .set("Authorization", "Bearer requeue-test-secret")
      .send({ syncRunId: "26f87a65-9830-44f2-9d39-67c0b4e5eee8" });

    expect(res.status).toBe(200);
    expect(mocks.requeueBlockedMetaFinalizers).toHaveBeenCalledTimes(1);
  });
});