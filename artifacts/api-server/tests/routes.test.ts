import { describe, it, expect, vi, beforeAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
// Point to workspace root config/ from artifacts/api-server/tests/
const CONFIG_DIR = resolve(__dir, "../../../config");
process.env["CONFIG_DIR"] = CONFIG_DIR;

// ── DB mock (feed-health and recommendations require @workspace/db) ───────────
vi.mock("@workspace/db", () => {
  // A Proxy that acts as a chainable query builder resolving to [].
  // Every property access returns a function that returns a new proxy;
  // `then` / `catch` are forwarded to Promise.resolve([]) so `await chain` = [].
  function makeQueryProxy(): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (
              onfulfilled: ((v: unknown[]) => unknown) | null | undefined,
              onrejected: ((e: unknown) => unknown) | null | undefined,
            ) => Promise.resolve([]).then(onfulfilled, onrejected);
          }
          if (prop === "catch") {
            return (onrejected: (e: unknown) => unknown) =>
              Promise.resolve([]).catch(onrejected);
          }
          // Any other method → function that returns a fresh proxy
          return () => makeQueryProxy();
        },
      },
    );
  }

  const mockInsert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      returning: vi.fn().mockResolvedValue([]),
    }),
  });

  return {
    db: {
      select: vi.fn().mockImplementation(() => makeQueryProxy()),
      insert: mockInsert,
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    },
    syncRunsTable: {},
    feedItemsTable: {},
    feedSnapshotsTable: {},
    syncErrorsTable: {},
    channelDiagnosticsTable: {},
    recommendationsTable: {},
    productsTable: {},
    variantsTable: {},
    marketVariantsTable: {},
    webhookEventsTable: {},
    sql: vi.fn().mockReturnValue(""),
  };
});

// ── Build the full router ─────────────────────────────────────────────────────

async function buildApp(): Promise<Express> {
  const app = express();
  app.use(express.json());

  // Minimal pino-like req.log shim
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, (...args: unknown[]) => void> }).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    next();
  });

  const { default: router } = await import("../src/routes/index");
  app.use("/api", router);
  return app;
}

let app: Express;
beforeAll(async () => {
  app = await buildApp();
});

// ── Health routes ─────────────────────────────────────────────────────────────

describe("GET /api/health", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });

  it("responds with JSON content-type", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});

describe("GET /api/healthz (alias)", () => {
  it("returns 200 with status ok (backwards-compatible alias)", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });
});

// ── Feed health route ─────────────────────────────────────────────────────────

describe("GET /api/feed-health", () => {
  it("returns 200 with expected shape", async () => {
    const res = await request(app).get("/api/feed-health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("lastRuns");
    expect(res.body).toHaveProperty("eligibilityCounts");
    expect(res.body).toHaveProperty("marketCounts");
    expect(res.body).toHaveProperty("generatedAt");
    expect(Array.isArray(res.body.lastRuns)).toBe(true);
  });

  it("generatedAt is a valid ISO timestamp", async () => {
    const res = await request(app).get("/api/feed-health");
    expect(() => new Date(res.body.generatedAt as string).toISOString()).not.toThrow();
  });
});

// ── Internal auth route ───────────────────────────────────────────────────────

describe("GET /api/internal/* — auth enforcement", () => {
  it("returns 503 when INTERNAL_API_SECRET is not configured", async () => {
    const saved = process.env["INTERNAL_API_SECRET"];
    delete process.env["INTERNAL_API_SECRET"];

    const res = await request(app).get("/api/internal/runs");
    expect(res.status).toBe(503);

    if (saved !== undefined) process.env["INTERNAL_API_SECRET"] = saved;
  });

  it("returns 401 when Authorization header is absent but secret is configured", async () => {
    process.env["INTERNAL_API_SECRET"] = "test-secret";

    const res = await request(app).get("/api/internal/runs");
    expect(res.status).toBe(401);

    delete process.env["INTERNAL_API_SECRET"];
  });

  it("returns 403 when wrong secret is provided", async () => {
    process.env["INTERNAL_API_SECRET"] = "correct-secret";

    const res = await request(app)
      .get("/api/internal/runs")
      .set("Authorization", "Bearer wrong-secret");
    expect(res.status).toBe(403);

    delete process.env["INTERNAL_API_SECRET"];
  });

  it("returns 200 when correct secret is provided", async () => {
    process.env["INTERNAL_API_SECRET"] = "correct-secret";

    const res = await request(app)
      .get("/api/internal/runs")
      .set("Authorization", "Bearer correct-secret");
    expect(res.status).toBe(200);

    delete process.env["INTERNAL_API_SECRET"];
  });
});

// ── 404 for unknown routes ────────────────────────────────────────────────────

describe("Unknown routes", () => {
  it("returns 404 for an unmapped path", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
  });
});
