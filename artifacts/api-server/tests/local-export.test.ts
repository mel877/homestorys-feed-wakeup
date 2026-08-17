/**
 * Tests for the localhost-only export trigger routes:
 *   POST /api/local/export/meta
 *   POST /api/local/export/google
 *
 * Critical invariant: every local trigger must serialize behind the shared
 * `withExportLock`, identical to the scheduler and internal-sync paths.
 * Concurrent publishes overwrite the same current-path objects and
 * feed_snapshots isCurrent rows, so the lock must be acquired before any
 * exporter function runs.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
process.env["CONFIG_DIR"] = resolve(__dir, "../../../config");

// ── Hoisted spy declarations ──────────────────────────────────────────────────

const {
  mockWithExportLock,
  mockRunMetaExport,
  mockRunGoogleExport,
} = vi.hoisted(() => ({
  // withExportLock: calls fn() inline (no real locking needed in unit tests)
  mockWithExportLock: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
  mockRunMetaExport: vi.fn().mockResolvedValue({ totalCanonicals: 42, durationMs: 100, files: {}, dryRun: false }),
  mockRunGoogleExport: vi.fn().mockResolvedValue({ totalCanonicals: 42, durationMs: 100, markets: {} }),
}));

vi.mock("../src/exporters/export-lock", () => ({
  withExportLock: mockWithExportLock,
  EXPORT_LOCK_JOB_NAME: "feed-export",
}));

vi.mock("../src/exporters/meta/generator", () => ({
  runMetaExport: mockRunMetaExport,
}));

vi.mock("../src/exporters/google/runner", () => ({
  runGoogleExport: mockRunGoogleExport,
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  },
  syncRunsTable: {},
  feedSnapshotsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn().mockReturnValue({}),
  and: vi.fn().mockReturnValue({}),
  desc: vi.fn().mockReturnValue({}),
  inArray: vi.fn().mockReturnValue({}),
}));

// ── App setup ─────────────────────────────────────────────────────────────────

async function buildTestApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  // Simulate loopback origin so requireLocalhost middleware passes
  app.use((req, _res, next) => {
    Object.defineProperty(req, "ip", { get: () => "127.0.0.1", configurable: true });
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

describe("POST /api/local/export/meta — lock invariant", () => {
  it("responds immediately with 200 started", async () => {
    const res = await request(app).post("/api/local/export/meta");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "started" });
  });

  it("acquires withExportLock before calling runMetaExport", async () => {
    mockWithExportLock.mockClear();
    mockRunMetaExport.mockClear();

    const callOrder: string[] = [];
    mockWithExportLock.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      callOrder.push("lock-acquired");
      const result = await fn();
      callOrder.push("lock-released");
      return result;
    });
    mockRunMetaExport.mockImplementationOnce(async () => {
      callOrder.push("meta-export");
      return { totalCanonicals: 1, durationMs: 50, files: {}, dryRun: false };
    });

    await request(app).post("/api/local/export/meta");

    // Wait for the fire-and-forget job to complete
    await vi.waitFor(() => {
      expect(mockRunMetaExport).toHaveBeenCalledOnce();
    });

    // Lock must be acquired BEFORE the exporter runs and released AFTER
    const lockIdx = callOrder.indexOf("lock-acquired");
    const exportIdx = callOrder.indexOf("meta-export");
    const releaseIdx = callOrder.indexOf("lock-released");
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(exportIdx).toBeGreaterThan(lockIdx);
    expect(releaseIdx).toBeGreaterThan(exportIdx);
  });

  it("releases withExportLock even when runMetaExport throws", async () => {
    mockWithExportLock.mockClear();
    mockRunMetaExport.mockClear();

    let lockReleased = false;
    mockWithExportLock.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      try {
        return await fn();
      } finally {
        lockReleased = true;
      }
    });
    mockRunMetaExport.mockRejectedValueOnce(new Error("Exporter crash"));

    await request(app).post("/api/local/export/meta");

    await vi.waitFor(() => {
      expect(mockRunMetaExport).toHaveBeenCalledOnce();
    });
    // Give the finally block a chance to run
    await vi.waitFor(() => {
      expect(lockReleased).toBe(true);
    });
  });
});

describe("POST /api/local/export/google — lock invariant", () => {
  it("responds immediately with 200 started", async () => {
    const res = await request(app).post("/api/local/export/google");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "started" });
  });

  it("acquires withExportLock before calling runGoogleExport", async () => {
    mockWithExportLock.mockClear();
    mockRunGoogleExport.mockClear();

    const callOrder: string[] = [];
    mockWithExportLock.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      callOrder.push("lock-acquired");
      const result = await fn();
      callOrder.push("lock-released");
      return result;
    });
    mockRunGoogleExport.mockImplementationOnce(async () => {
      callOrder.push("google-export");
      return { totalCanonicals: 1, durationMs: 50, markets: {} };
    });

    await request(app).post("/api/local/export/google");

    await vi.waitFor(() => {
      expect(mockRunGoogleExport).toHaveBeenCalledOnce();
    });

    const lockIdx = callOrder.indexOf("lock-acquired");
    const exportIdx = callOrder.indexOf("google-export");
    const releaseIdx = callOrder.indexOf("lock-released");
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(exportIdx).toBeGreaterThan(lockIdx);
    expect(releaseIdx).toBeGreaterThan(exportIdx);
  });

  it("releases withExportLock even when runGoogleExport throws", async () => {
    mockWithExportLock.mockClear();
    mockRunGoogleExport.mockClear();

    let lockReleased = false;
    mockWithExportLock.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      try {
        return await fn();
      } finally {
        lockReleased = true;
      }
    });
    mockRunGoogleExport.mockRejectedValueOnce(new Error("Google API down"));

    await request(app).post("/api/local/export/google");

    await vi.waitFor(() => {
      expect(mockRunGoogleExport).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(lockReleased).toBe(true);
    });
  });
});

describe("POST /api/local/export — access control", () => {
  it("rejects requests from non-localhost IPs", async () => {
    const nonLocalApp = express();
    nonLocalApp.use(express.json());
    // Simulate an external IP
    nonLocalApp.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { get: () => "203.0.113.1", configurable: true });
      (req as unknown as { log: Record<string, () => void> }).log = {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      };
      next();
    });
    const { default: router } = await import("../src/routes/index");
    nonLocalApp.use("/api", router);

    const metaRes = await request(nonLocalApp).post("/api/local/export/meta");
    const googleRes = await request(nonLocalApp).post("/api/local/export/google");
    expect(metaRes.status).toBe(403);
    expect(googleRes.status).toBe(403);
  });
});
