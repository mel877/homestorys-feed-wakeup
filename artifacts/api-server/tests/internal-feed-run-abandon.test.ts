import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const RUN_ID = "79362d72-9303-4a3b-8d92-9a81d932c079";

const mocks = vi.hoisted(() => {
  class MockDurableFeedRunAbandonError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
      this.name = "DurableFeedRunAbandonError";
    }
  }

  return {
    abandonDurableFeedRun: vi.fn(),
    DurableFeedRunAbandonError: MockDurableFeedRunAbandonError,
  };
});

process.env["INTERNAL_API_SECRET"] = "abandon-test-secret";

vi.mock("../src/jobs/feed-export-step-repository", () => mocks);

async function buildApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("../src/routes/feed-runs");
  app.use("/api/internal", router);
  return app;
}

let app: Express;
beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  mocks.abandonDurableFeedRun.mockReset();
  mocks.abandonDurableFeedRun.mockResolvedValue({
    syncRunId: RUN_ID,
    abandonedSteps: 121,
  });
});

describe("POST /api/internal/feed-runs/abandon", () => {
  it("requires internal authentication", async () => {
    const res = await request(app)
      .post("/api/internal/feed-runs/abandon")
      .send({
        syncRunId: RUN_ID,
        confirmation: "ABANDON_DURABLE_FEED_RUN",
      });

    expect(res.status).toBe(401);
    expect(mocks.abandonDurableFeedRun).not.toHaveBeenCalled();
  });

  it("rejects an invalid internal secret", async () => {
    const res = await request(app)
      .post("/api/internal/feed-runs/abandon")
      .set("Authorization", "Bearer wrong")
      .send({
        syncRunId: RUN_ID,
        confirmation: "ABANDON_DURABLE_FEED_RUN",
      });

    expect(res.status).toBe(403);
    expect(mocks.abandonDurableFeedRun).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { syncRunId: RUN_ID },
    { syncRunId: RUN_ID, confirmation: "WRONG" },
    {
      syncRunId: RUN_ID,
      confirmation: "ABANDON_DURABLE_FEED_RUN",
      extra: true,
    },
  ])("rejects an invalid body: %j", async (body) => {
    const res = await request(app)
      .post("/api/internal/feed-runs/abandon")
      .set("Authorization", "Bearer abandon-test-secret")
      .send(body);

    expect(res.status).toBe(400);
    expect(mocks.abandonDurableFeedRun).not.toHaveBeenCalled();
  });

  it("abandons the requested run only", async () => {
    const res = await request(app)
      .post("/api/internal/feed-runs/abandon")
      .set("Authorization", "Bearer abandon-test-secret")
      .send({
        syncRunId: RUN_ID,
        confirmation: "ABANDON_DURABLE_FEED_RUN",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "abandoned",
      syncRunId: RUN_ID,
      abandonedSteps: 121,
    });
    expect(mocks.abandonDurableFeedRun).toHaveBeenCalledWith(RUN_ID);
  });

  it("returns the guarded repository error", async () => {
    mocks.abandonDurableFeedRun.mockRejectedValueOnce(
      new mocks.DurableFeedRunAbandonError(
        "Durable feed run has running steps and cannot be abandoned",
        409,
      ),
    );

    const res = await request(app)
      .post("/api/internal/feed-runs/abandon")
      .set("Authorization", "Bearer abandon-test-secret")
      .send({
        syncRunId: RUN_ID,
        confirmation: "ABANDON_DURABLE_FEED_RUN",
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      status: "error",
      error: "Durable feed run has running steps and cannot be abandoned",
    });
  });
});