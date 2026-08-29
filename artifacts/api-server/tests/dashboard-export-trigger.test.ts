import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const {
  mockTryAcquireLock,
  mockReleaseLock,
  mockRunGoogleExport,
  mockRunMetaExport,
  mockTrackerStart,
  mockTrackerComplete,
  mockTrackerFail,
  mockTrackerLogError,
  mockCheckAlerts,
  mockTracker,
} = vi.hoisted(() => {
  const tracker = {
    start: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    logError: vi.fn(),
  };

  return {
    mockTryAcquireLock: vi.fn(),
    mockReleaseLock: vi.fn(),
    mockRunGoogleExport: vi.fn(),
    mockRunMetaExport: vi.fn(),
    mockTrackerStart: tracker.start,
    mockTrackerComplete: tracker.complete,
    mockTrackerFail: tracker.fail,
    mockTrackerLogError: tracker.logError,
    mockCheckAlerts: vi.fn(),
    mockTracker: tracker,
  };
});

vi.mock("../src/routes/dashboard/auth", () => ({
  requireDashboardAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  default: {},
}));

vi.mock("@workspace/db", () => ({
  db: {},
  syncRunsTable: {},
  syncErrorsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  desc: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("../src/jobs/scheduler", () => ({
  tryAcquireLock: mockTryAcquireLock,
  releaseLock: mockReleaseLock,
}));

vi.mock("../src/exporters/google/runner", () => ({
  runGoogleExport: mockRunGoogleExport,
}));

vi.mock("../src/exporters/meta/fresh-process", () => ({
  runMetaExportInFreshProcess: mockRunMetaExport,
}));

vi.mock("../src/shopify/sync-run-tracker", () => ({
  SyncRunTracker: vi.fn(() => mockTracker),
}));

vi.mock("../src/observability/alerts", () => ({
  checkAlerts: mockCheckAlerts,
}));

async function buildTestApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("../src/routes/dashboard/runs");
  app.use("/api", router);
  return app;
}

let app: Express;

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockTryAcquireLock.mockResolvedValue({ acquired: true });
  mockRunGoogleExport.mockResolvedValue({
    markets: ["CH_DE", "CH_FR"],
    totalCanonicals: 5235,
    byMarket: {},
    localInventory: { submitted: 0, failed: 0 },
    dryRun: false,
    durationMs: 100,
  });
  mockRunMetaExport.mockResolvedValue(undefined);
  mockTrackerStart.mockResolvedValue("export-run-001");
  mockTrackerComplete.mockResolvedValue(undefined);
  mockTrackerFail.mockResolvedValue(undefined);
  mockTrackerLogError.mockResolvedValue(undefined);
  mockCheckAlerts.mockResolvedValue([]);
});

describe('POST /api/dashboard/sync-runs/trigger with runType "export"', () => {
  it("keeps the response open through Google and Meta, then releases the lock before responding", async () => {
    const order: string[] = [];
    let resolveGoogle!: (value: unknown) => void;
    let resolveMeta!: () => void;
    let responseSettled = false;

    mockTryAcquireLock.mockImplementationOnce(async () => {
      order.push("lock-acquired");
      return { acquired: true };
    });
    mockRunGoogleExport.mockImplementationOnce(async () => {
      order.push("google-start");
      const result = await new Promise<unknown>((resolve) => {
        resolveGoogle = resolve;
      });
      order.push("google-finished");
      return result;
    });
    mockRunMetaExport.mockImplementationOnce(async () => {
      order.push("meta-start");
      await new Promise<void>((resolve) => {
        resolveMeta = resolve;
      });
      order.push("meta-finished");
    });
    mockReleaseLock.mockImplementationOnce(() => {
      order.push("lock-released");
    });

    const responsePromise = request(app)
      .post("/api/dashboard/sync-runs/trigger")
      .send({ runType: "export" })
      .then((response) => {
        responseSettled = true;
        return response;
      });

    await vi.waitFor(() => {
      expect(mockRunGoogleExport).toHaveBeenCalledWith({ syncRunId: "export-run-001" });
    });
    expect(responseSettled).toBe(false);
    expect(mockRunMetaExport).not.toHaveBeenCalled();

    resolveGoogle({
      markets: ["CH_DE", "CH_FR"],
      totalCanonicals: 5235,
      byMarket: {},
      localInventory: { submitted: 0, failed: 0 },
      dryRun: false,
      durationMs: 100,
    });

    await vi.waitFor(() => {
      expect(mockRunMetaExport).toHaveBeenCalledWith({ syncRunId: "export-run-001" });
    });
    expect(responseSettled).toBe(false);

    resolveMeta();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      runType: "export",
      status: "completed",
      runId: "export-run-001",
      result: {
        meta: { completed: true },
      },
    });
    expect(mockTrackerComplete).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "lock-acquired",
      "google-start",
      "google-finished",
      "meta-start",
      "meta-finished",
      "lock-released",
    ]);
    expect(responseSettled).toBe(true);
  });

  it("returns a structured 500 with the runId when a channel export fails", async () => {
    mockRunGoogleExport.mockRejectedValueOnce(new Error("Google publish failed"));

    const response = await request(app)
      .post("/api/dashboard/sync-runs/trigger")
      .send({ runType: "export" });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      runType: "export",
      status: "failed",
      runId: "export-run-001",
      error: "google: Google publish failed",
      errors: {
        google: "Google publish failed",
      },
    });
    expect(mockRunMetaExport).toHaveBeenCalledWith({ syncRunId: "export-run-001" });
    expect(mockTrackerLogError).toHaveBeenCalledWith({
      errorType: "export_failed",
      entityType: "channel",
      entityId: "google",
      message: "Google publish failed",
    });
    expect(mockTrackerComplete).not.toHaveBeenCalled();
    expect(mockTrackerFail).toHaveBeenCalledOnce();
    expect(mockTrackerFail.mock.calls[0]?.[0]).toMatchObject({
      message: "google: Google publish failed",
    });
    expect(mockReleaseLock).toHaveBeenCalledWith("feed-export");
  });

  it("marks the run failed when Meta fails after Google completes", async () => {
    mockRunMetaExport.mockRejectedValueOnce(new Error("Meta child failed"));

    const response = await request(app)
      .post("/api/dashboard/sync-runs/trigger")
      .send({ runType: "export" });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      runId: "export-run-001",
      error: "meta: Meta child failed",
      errors: {
        meta: "Meta child failed",
      },
    });
    expect(mockTrackerComplete).not.toHaveBeenCalled();
    expect(mockTrackerFail.mock.calls[0]?.[0]).toMatchObject({
      message: "meta: Meta child failed",
    });
  });

  it("aggregates Google and Meta failures into one failed terminal run", async () => {
    mockRunGoogleExport.mockRejectedValueOnce(new Error("Google failed"));
    mockRunMetaExport.mockRejectedValueOnce(new Error("Meta failed"));

    const response = await request(app)
      .post("/api/dashboard/sync-runs/trigger")
      .send({ runType: "export" });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      runId: "export-run-001",
      error: "google: Google failed; meta: Meta failed",
      errors: {
        google: "Google failed",
        meta: "Meta failed",
      },
    });
    expect(mockTrackerFail).toHaveBeenCalledOnce();
    expect(mockTrackerComplete).not.toHaveBeenCalled();
  });

  it("marks the run failed if successful export finalization throws", async () => {
    mockTrackerComplete.mockRejectedValueOnce(new Error("Completion write failed"));

    const response = await request(app)
      .post("/api/dashboard/sync-runs/trigger")
      .send({ runType: "export" });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      runId: "export-run-001",
      error: "Completion write failed",
    });
    expect(mockTrackerFail.mock.calls[0]?.[0]).toMatchObject({
      message: "Completion write failed",
    });
    expect(mockReleaseLock).toHaveBeenCalledWith("feed-export");
  });

  it("does not detach the post-run alert check from the export request", async () => {
    let resolveAlerts!: () => void;
    let responseSettled = false;
    mockCheckAlerts.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveAlerts = resolve;
      }),
    );

    const responsePromise = request(app)
      .post("/api/dashboard/sync-runs/trigger")
      .send({ runType: "export" })
      .then((response) => {
        responseSettled = true;
        return response;
      });

    await vi.waitFor(() => {
      expect(mockCheckAlerts).toHaveBeenCalledWith("export-run-001");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(responseSettled).toBe(false);

    resolveAlerts();
    const response = await responsePromise;
    expect(response.status).toBe(200);
  });
});