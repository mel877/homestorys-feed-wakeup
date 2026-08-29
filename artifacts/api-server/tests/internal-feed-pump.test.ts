import { beforeAll, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

process.env["INTERNAL_API_SECRET"] = "pump-test-secret";

const mockRunDurableFeedPump = vi.fn().mockResolvedValue({
  status: "idle",
  processed: 0,
  reclaimed: 0,
  elapsedMs: 2,
  remainingBudgetMs: 29_998,
});

vi.mock("../src/jobs/durable-feed-pump", () => ({
  MAX_PUMP_BUDGET_MS: 40_000,
  MAX_PUMP_STEPS: 8,
  runDurableFeedPump: mockRunDurableFeedPump,
}));

async function buildApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("../src/routes/feed-pump");
  app.use("/api/internal", router);
  return app;
}

let app: Express;
beforeAll(async () => {
  app = await buildApp();
});

describe("POST /api/internal/feed-pump", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await request(app).post("/api/internal/feed-pump");
    expect(res.status).toBe(401);
    expect(mockRunDurableFeedPump).not.toHaveBeenCalled();
  });

  it("rejects an invalid secret", async () => {
    const res = await request(app)
      .post("/api/internal/feed-pump")
      .set("Authorization", "Bearer wrong");
    expect(res.status).toBe(403);
    expect(mockRunDurableFeedPump).not.toHaveBeenCalled();
  });

  it("returns the durable pump result", async () => {
    const res = await request(app)
      .post("/api/internal/feed-pump")
      .set("Authorization", "Bearer pump-test-secret")
      .send({ budgetMs: 1_000, maxSteps: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "idle", processed: 0 });
    expect(mockRunDurableFeedPump).toHaveBeenCalledWith(
      expect.objectContaining({ budgetMs: 1_000, maxSteps: 2 }),
    );
  });

  it("returns 409 for a lease or finalization conflict", async () => {
    mockRunDurableFeedPump.mockResolvedValueOnce({
      status: "conflict",
      processed: 0,
      reclaimed: 0,
      elapsedMs: 3,
      remainingBudgetMs: 29_997,
      steps: [],
    });
    const res = await request(app)
      .post("/api/internal/feed-pump")
      .set("Authorization", "Bearer pump-test-secret");
    expect(res.status).toBe(409);
    expect(res.body.status).toBe("conflict");
  });

  it("returns 503 for an infrastructure error before a step is claimed", async () => {
    mockRunDurableFeedPump.mockRejectedValueOnce(new Error("database unavailable"));
    const res = await request(app)
      .post("/api/internal/feed-pump")
      .set("Authorization", "Bearer pump-test-secret");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("transient_error");
  });

  it("rejects a budget above the hard maximum", async () => {
    const res = await request(app)
      .post("/api/internal/feed-pump")
      .set("Authorization", "Bearer pump-test-secret")
      .send({ budgetMs: 40_001 });
    expect(res.status).toBe(400);
  });
});