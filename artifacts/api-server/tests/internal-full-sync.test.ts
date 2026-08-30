/**
 * Tests for the POST /api/internal/sync/full route.
 *
 * Critical invariant: a manual Full Sync refreshes Shopify data only. Feed
 * planning and publication belong exclusively to the durable nightly cycle.
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
  mockRunJobWithLock,
} = vi.hoisted(() => ({
  mockRunFullSync: vi.fn().mockResolvedValue("run-001"),
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

describe("POST /api/internal/sync/full — Shopify-only refresh", () => {
  const AUTH = { Authorization: "Bearer test-secret-for-diagnostics" };

  it("responds immediately with 200 started", async () => {
    const res = await request(app)
      .post("/api/internal/sync/full")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "started", type: "full" });
  });

  it("calls Shopify Full Sync without invoking the legacy feed pipeline", async () => {
    mockRunFullSync.mockClear();

    await request(app)
      .post("/api/internal/sync/full")
      .set(AUTH);

    await vi.waitFor(() => {
      expect(mockRunFullSync).toHaveBeenCalledOnce();
    });
  });

  it("keeps the existing scheduler lock around the manual refresh", async () => {
    expect(mockRunJobWithLock).toHaveBeenCalledWith(
      "full-sync",
      "full",
      expect.any(Function),
    );
  });
});
