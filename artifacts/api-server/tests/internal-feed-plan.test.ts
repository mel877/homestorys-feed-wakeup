import { beforeAll, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

process.env["INTERNAL_API_SECRET"] = "plan-test-secret";

const mockPlanDurableFeedRun = vi.fn().mockResolvedValue({
  status: "planned",
  runId: "run-plan-001",
  productCount: 2_129,
  buildSteps: 171,
  finalizeSteps: 19,
  totalSteps: 190,
});

vi.mock("../src/jobs/durable-feed-planner", () => ({
  DURABLE_FEED_PLAN_CONFIRMATION: "PLAN_DURABLE_FEEDS",
  planDurableFeedRun: mockPlanDurableFeedRun,
}));

async function buildApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("../src/routes/feed-plan");
  app.use("/api/internal", router);
  return app;
}

let app: Express;
beforeAll(async () => {
  app = await buildApp();
});

describe("POST /api/internal/feed-plan", () => {
  it("rejects missing authentication before planning", async () => {
    const res = await request(app).post("/api/internal/feed-plan");
    expect(res.status).toBe(401);
    expect(mockPlanDurableFeedRun).not.toHaveBeenCalled();
  });

  it("rejects an invalid secret before planning", async () => {
    const res = await request(app)
      .post("/api/internal/feed-plan")
      .set("Authorization", "Bearer wrong");
    expect(res.status).toBe(403);
    expect(mockPlanDurableFeedRun).not.toHaveBeenCalled();
  });

  it("requires the exact planning confirmation", async () => {
    const res = await request(app)
      .post("/api/internal/feed-plan")
      .set("Authorization", "Bearer plan-test-secret")
      .send({ confirmation: "PLAN_FEEDS" });
    expect(res.status).toBe(400);
    expect(mockPlanDurableFeedRun).not.toHaveBeenCalled();
  });

  it("rejects a missing confirmation", async () => {
    const res = await request(app)
      .post("/api/internal/feed-plan")
      .set("Authorization", "Bearer plan-test-secret")
      .send({});
    expect(res.status).toBe(400);
    expect(mockPlanDurableFeedRun).not.toHaveBeenCalled();
  });

  it("returns the planned run and never starts the pump", async () => {
    const res = await request(app)
      .post("/api/internal/feed-plan")
      .set("Authorization", "Bearer plan-test-secret")
      .send({ confirmation: "PLAN_DURABLE_FEEDS" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "planned",
      runId: "run-plan-001",
      totalSteps: 190,
    });
    expect(mockPlanDurableFeedRun).toHaveBeenCalledWith({
      confirmation: "PLAN_DURABLE_FEEDS",
    });
  });

  it("returns 409 when an active durable cycle exists", async () => {
    mockPlanDurableFeedRun.mockResolvedValueOnce({
      status: "conflict",
      productCount: 0,
      buildSteps: 0,
      finalizeSteps: 0,
      totalSteps: 0,
    });
    const res = await request(app)
      .post("/api/internal/feed-plan")
      .set("Authorization", "Bearer plan-test-secret")
      .send({ confirmation: "PLAN_DURABLE_FEEDS" });
    expect(res.status).toBe(409);
    expect(res.body.status).toBe("conflict");
  });
});