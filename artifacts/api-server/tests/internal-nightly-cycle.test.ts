import { beforeAll, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

process.env["INTERNAL_API_SECRET"] = "nightly-test-secret";

const { mockAdvanceNightlyCycle } = vi.hoisted(() => ({
  mockAdvanceNightlyCycle: vi.fn().mockResolvedValue({
    status: "running",
    phase: "pricing",
    sourceSyncRunId: "shopify-run-1",
  }),
}));

vi.mock("../src/jobs/nightly-cycle", () => ({
  advanceNightlyCycle: mockAdvanceNightlyCycle,
}));

async function buildApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    next();
  });
  const { default: router } = await import("../src/routes/nightly-cycle");
  app.use("/api/internal", router);
  return app;
}

let app: Express;
beforeAll(async () => {
  app = await buildApp();
});

describe("POST /api/internal/nightly-cycle", () => {
  it("requires internal authentication", async () => {
    const response = await request(app)
      .post("/api/internal/nightly-cycle")
      .send({ cycleKey: "2026-08-30" });
    expect(response.status).toBe(401);
  });

  it("returns the durable phase and status", async () => {
    const response = await request(app)
      .post("/api/internal/nightly-cycle")
      .set("Authorization", "Bearer nightly-test-secret")
      .send({ cycleKey: "2026-08-30" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "running",
      phase: "pricing",
      sourceSyncRunId: "shopify-run-1",
    });
    expect(mockAdvanceNightlyCycle).toHaveBeenCalledWith({
      cycleKey: "2026-08-30",
    });
  });
});