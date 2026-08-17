/**
 * Tests for the POST /api/internal/sync/full route.
 *
 * Critical invariant: both the scheduler and the API-triggered full-sync path
 * must perform identical post-export steps. Specifically, `fetchAndStoreDiagnostics`
 * must be called after `runGoogleExport` in both paths. This test covers the
 * API/CLI path (the scheduler path is covered by scheduler.test.ts).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
process.env["CONFIG_DIR"] = resolve(__dir, "../../../config");
process.env["INTERNAL_API_SECRET"] = "test-secret-for-diagnostics";

// ── Hoisted spy declarations ──────────────────────────────────────────────────

const {
  mockRunFullSync,
  mockRunGoogleExport,
  mockRunMetaExport,
  mockFetchAndStoreDiagnostics,
  mockRunJobWithLock,
} = vi.hoisted(() => ({
  mockRunFullSync: vi.fn().mockResolvedValue("run-001"),
  mockRunGoogleExport: vi.fn().mockResolvedValue(undefined),
  mockRunMetaExport: vi.fn().mockResolvedValue(undefined),
  mockFetchAndStoreDiagnostics: vi.fn().mockResolvedValue({ total: 0, critical: 0, errors: 0, warnings: 0 }),
  // runJobWithLock: immediately executes the job function inline (no async delay)
  mockRunJobWithLock: vi.fn().mockImplementation(
    async (_name: string, _type: string, fn: () => Promise<string>) => fn(),
  ),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
        orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  },
  syncRunsTable: {},
  syncErrorsTable: {},
  feedSnapshotsTable: {},
  channelDiagnosticsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn().mockReturnValue({}),
  and: vi.fn().mockReturnValue({}),
  desc: vi.fn().mockReturnValue({}),
  gt: vi.fn().mockReturnValue({}),
  gte: vi.fn().mockReturnValue({}),
  inArray: vi.fn().mockReturnValue({}),
  count: vi.fn().mockReturnValue({}),
  isNull: vi.fn().mockReturnValue({}),
}));

// Mock the modules that internal.ts dynamically imports
vi.mock("../src/shopify/index", () => ({
  runFullSync: mockRunFullSync,
  runInventorySync: vi.fn().mockResolvedValue("run-inv"),
  runPriceSync: vi.fn().mockResolvedValue("run-price"),
  syncProduct: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/exporters/google/runner", () => ({
  runGoogleExport: mockRunGoogleExport,
}));

vi.mock("../src/exporters/meta/generator", () => ({
  runMetaExport: mockRunMetaExport,
}));

vi.mock("../src/exporters/google/diagnostics", () => ({
  fetchAndStoreDiagnostics: mockFetchAndStoreDiagnostics,
}));

// runJobWithLock: executes the job inline so we can await completion
vi.mock("../src/jobs/scheduler", () => ({
  runJobWithLock: mockRunJobWithLock,
  stopScheduler: vi.fn(),
  msUntilNext: vi.fn(),
  // tryAcquireLock / releaseLock are used by export-lock.ts; mocked via
  // withExportLock below so these stubs are kept as safety nets only.
  tryAcquireLock: vi.fn().mockResolvedValue({ acquired: true }),
  releaseLock: vi.fn(),
}));

// withExportLock: call fn() directly (no DB-backed lock needed in unit tests)
vi.mock("../src/exporters/export-lock", () => ({
  withExportLock: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
  EXPORT_LOCK_JOB_NAME: "feed-export",
}));

// Suppress alert checks and recommendations sync (not under test)
vi.mock("../src/observability/alerts", () => ({
  checkAlerts: vi.fn().mockResolvedValue([]),
  getActiveAlerts: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/jobs/sync-recommendations", () => ({
  runRecommendationsSync: vi.fn().mockResolvedValue("run-recs"),
}));

// ── App setup ─────────────────────────────────────────────────────────────────

async function buildTestApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
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
  app = await buildTestApp();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/internal/sync/full — diagnostics reconciliation", () => {
  const AUTH = { Authorization: "Bearer test-secret-for-diagnostics" };

  it("responds immediately with 200 started", async () => {
    const res = await request(app)
      .post("/api/internal/sync/full")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "started", type: "full" });
  });

  it("calls runFullSync, runGoogleExport, and fetchAndStoreDiagnostics in order", async () => {
    mockRunFullSync.mockClear();
    mockRunGoogleExport.mockClear();
    mockFetchAndStoreDiagnostics.mockClear();

    await request(app)
      .post("/api/internal/sync/full")
      .set(AUTH);

    // The route is fire-and-forget: res.json() is sent before the job promise chain
    // resolves.  Poll until all three mocks have been called (vi.waitFor retries
    // for up to 1 s by default, which is more than enough for the micro-task chain).
    await vi.waitFor(() => {
      expect(mockRunFullSync).toHaveBeenCalledOnce();
    });
    expect(mockRunGoogleExport).toHaveBeenCalledWith({ syncRunId: "run-001" });
    expect(mockFetchAndStoreDiagnostics).toHaveBeenCalledOnce();
  });

  it("fetchAndStoreDiagnostics is called AFTER runGoogleExport (call order)", async () => {
    const callOrder: string[] = [];
    mockRunGoogleExport.mockImplementation(async () => { callOrder.push("google"); });
    mockFetchAndStoreDiagnostics.mockImplementation(async () => { callOrder.push("diagnostics"); });

    await request(app)
      .post("/api/internal/sync/full")
      .set(AUTH);

    // Wait for the async fire-and-forget job to populate callOrder
    await vi.waitFor(() => {
      expect(callOrder.length).toBeGreaterThanOrEqual(2);
    });

    const googleIdx = callOrder.indexOf("google");
    const diagIdx = callOrder.indexOf("diagnostics");
    expect(googleIdx).toBeGreaterThanOrEqual(0);
    expect(diagIdx).toBeGreaterThan(googleIdx);

    // Restore
    mockRunGoogleExport.mockResolvedValue(undefined);
    mockFetchAndStoreDiagnostics.mockResolvedValue({ total: 0, critical: 0, errors: 0, warnings: 0 });
  });

  it("fetchAndStoreDiagnostics is still called even when runGoogleExport throws", async () => {
    mockRunGoogleExport.mockRejectedValueOnce(new Error("Google API down"));
    mockFetchAndStoreDiagnostics.mockClear();

    await request(app)
      .post("/api/internal/sync/full")
      .set(AUTH);

    // Google export failure is caught (.catch) — diagnostics must still run
    expect(mockFetchAndStoreDiagnostics).toHaveBeenCalledOnce();
  });
});
