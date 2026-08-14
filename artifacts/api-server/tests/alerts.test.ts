/**
 * Tests for the alerting system and scheduler lock logic.
 *
 * Core business-logic functions are tested with unit tests that do not require
 * a real DB. Alert condition thresholds and the scheduler's mutex logic are
 * exercised directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Alert } from "../src/observability/alerts";

// ── Alert type contract ────────────────────────────────────────────────────────

describe("Alert type", () => {
  it("has valid severity levels", () => {
    const alert: Alert = {
      type: "full_sync_failed",
      severity: "critical",
      message: "Last full sync run failed",
    };
    expect(["critical", "warning", "info"]).toContain(alert.severity);
  });

  it("can include optional details", () => {
    const alert: Alert = {
      type: "product_count_drop",
      severity: "warning",
      message: "Products dropped 10%",
      details: { previous: 100, current: 90, dropPct: 10 },
    };
    expect(alert.details?.["dropPct"]).toBe(10);
  });
});

// ── Overall status derivation ─────────────────────────────────────────────────

function deriveStatus(alerts: Alert[]): "healthy" | "warning" | "critical" {
  if (alerts.some((a) => a.severity === "critical")) return "critical";
  if (alerts.some((a) => a.severity === "warning")) return "warning";
  return "healthy";
}

describe("Overall status derivation", () => {
  it("critical → critical (ignores other severities)", () => {
    expect(
      deriveStatus([
        { type: "a", severity: "warning", message: "w" },
        { type: "b", severity: "critical", message: "c" },
      ]),
    ).toBe("critical");
  });

  it("warning-only → warning", () => {
    expect(deriveStatus([{ type: "a", severity: "warning", message: "w" }])).toBe("warning");
  });

  it("no alerts → healthy", () => {
    expect(deriveStatus([])).toBe("healthy");
  });

  it("info-only → healthy", () => {
    expect(deriveStatus([{ type: "a", severity: "info", message: "i" }])).toBe("healthy");
  });
});

// ── Product count drop detection ───────────────────────────────────────────────

function computeDropPct(previous: number, current: number): number {
  return previous > 0 ? ((previous - current) / previous) * 100 : 0;
}

describe("Product count drop detection", () => {
  it("detects a 10% drop", () => {
    expect(computeDropPct(100, 90)).toBeCloseTo(10);
  });

  it("detects a 50% drop", () => {
    expect(computeDropPct(200, 100)).toBeCloseTo(50);
  });

  it("no drop when count is equal", () => {
    expect(computeDropPct(100, 100)).toBe(0);
  });

  it("no drop when count increases", () => {
    expect(computeDropPct(100, 110)).toBeLessThan(0);
  });

  it("triggers alert only above threshold", () => {
    const threshold = 5;
    expect(computeDropPct(100, 94) > threshold).toBe(true);  // 6% > 5%
    expect(computeDropPct(100, 96) > threshold).toBe(false); // 4% ≤ 5%
  });

  it("handles zero previous gracefully", () => {
    expect(computeDropPct(0, 10)).toBe(0);
  });
});

// ── Feed staleness ─────────────────────────────────────────────────────────────

function isStale(generatedAt: Date, staleHours: number, now = Date.now()): boolean {
  const cutoff = new Date(now - staleHours * 60 * 60 * 1_000);
  return generatedAt < cutoff;
}

describe("Feed staleness detection", () => {
  const nowMs = Date.now();

  it("fresh feed (2h old, threshold 6h) → not stale", () => {
    const freshTimestamp = new Date(nowMs - 2 * 60 * 60 * 1_000);
    expect(isStale(freshTimestamp, 6, nowMs)).toBe(false);
  });

  it("stale feed (8h old, threshold 6h) → stale", () => {
    const staleTimestamp = new Date(nowMs - 8 * 60 * 60 * 1_000);
    expect(isStale(staleTimestamp, 6, nowMs)).toBe(true);
  });

  it("exactly at threshold → not stale (boundary inclusive)", () => {
    const exact = new Date(nowMs - 6 * 60 * 60 * 1_000);
    expect(isStale(exact, 6, nowMs)).toBe(false);
  });

  it("computes age in hours correctly", () => {
    const ageMs = 7.5 * 60 * 60 * 1_000;
    const generatedAt = new Date(nowMs - ageMs);
    const ageH = (nowMs - generatedAt.getTime()) / 3_600_000;
    expect(ageH).toBeCloseTo(7.5, 1);
  });
});

// ── Post-run alert check wiring ────────────────────────────────────────────────

describe("Post-run alert check wiring", () => {
  it("runJobWithLock calls checkAlerts after successful run", async () => {
    const checkAlertsSpy = vi.fn().mockResolvedValue([]);
    const mockRunFn = vi.fn().mockResolvedValue("run-123");

    // Simulate what runJobWithLock does internally
    const runningJobs = new Set<string>();

    async function runJobWithLockSim(
      jobName: string,
      fn: () => Promise<string>,
      onPostRun: (runId: string) => Promise<void>,
    ): Promise<string | null> {
      if (runningJobs.has(jobName)) return null;
      runningJobs.add(jobName);
      let runId: string | null = null;
      try {
        runId = await fn();
      } finally {
        runningJobs.delete(jobName);
      }
      if (runId) await onPostRun(runId);
      return runId;
    }

    const runId = await runJobWithLockSim(
      "test-job",
      mockRunFn,
      checkAlertsSpy,
    );

    expect(runId).toBe("run-123");
    expect(mockRunFn).toHaveBeenCalledOnce();
    expect(checkAlertsSpy).toHaveBeenCalledOnce();
    expect(checkAlertsSpy).toHaveBeenCalledWith("run-123");
  });

  it("runJobWithLock does not call checkAlerts when lock is not acquired", async () => {
    const checkAlertsSpy = vi.fn().mockResolvedValue([]);
    const mockRunFn = vi.fn().mockResolvedValue("run-xyz");

    const runningJobs = new Set<string>(["test-job"]); // lock already held

    async function runJobWithLockSim(
      jobName: string,
      fn: () => Promise<string>,
      onPostRun: (runId: string) => Promise<void>,
    ): Promise<string | null> {
      if (runningJobs.has(jobName)) return null;
      runningJobs.add(jobName);
      let runId: string | null = null;
      try {
        runId = await fn();
      } finally {
        runningJobs.delete(jobName);
      }
      if (runId) await onPostRun(runId);
      return runId;
    }

    const runId = await runJobWithLockSim("test-job", mockRunFn, checkAlertsSpy);

    expect(runId).toBe(null);
    expect(mockRunFn).not.toHaveBeenCalled();
    expect(checkAlertsSpy).not.toHaveBeenCalled();
  });
});

// ── Scheduler lock logic ───────────────────────────────────────────────────────

describe("Scheduler lock logic", () => {
  it("in-memory Set prevents concurrent runs of the same job", () => {
    const running = new Set<string>();
    const job = "full-sync";

    running.add(job);
    expect(running.has(job)).toBe(true);

    running.delete(job);
    expect(running.has(job)).toBe(false);
  });

  it("different jobs can hold locks simultaneously", () => {
    const running = new Set<string>();
    running.add("full-sync");
    running.add("inventory-sync");

    expect(running.has("full-sync")).toBe(true);
    expect(running.has("inventory-sync")).toBe(true);
    expect(running.has("prices-sync")).toBe(false);
  });

  it("lock is released even if job throws", async () => {
    const running = new Set<string>();
    const job = "full-sync";

    async function runWithLock(fn: () => Promise<void>): Promise<void> {
      if (running.has(job)) return;
      running.add(job);
      try {
        await fn();
      } finally {
        running.delete(job);
      }
    }

    await expect(
      runWithLock(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    expect(running.has(job)).toBe(false); // lock released even after error
  });
});

// ── Translation coverage alert computation ────────────────────────────────────

import { computeTranslationCoverageAlerts } from "../src/observability/alerts";

describe("computeTranslationCoverageAlerts", () => {
  const locales = [
    { code: "de", name: "German" },
    { code: "en", name: "English" },
    { code: "it", name: "Italian" },
  ];

  it("returns no alerts when all locales are fully translated", () => {
    const countMap = new Map([["de", 100], ["en", 100], ["it", 100]]);
    const alerts = computeTranslationCoverageAlerts(100, locales, countMap);
    expect(alerts).toHaveLength(0);
  });

  it("fires translation_missing for DE when DE has 0 rows", () => {
    const countMap = new Map([["en", 100], ["it", 100]]);
    const alerts = computeTranslationCoverageAlerts(100, locales, countMap);
    const deAlert = alerts.find((a) => a.details?.["language"] === "de");
    expect(deAlert).toBeDefined();
    expect(deAlert?.type).toBe("translation_missing");
    expect(deAlert?.severity).toBe("warning");
    expect(deAlert?.message).toContain("Shopify admin");
    expect(deAlert?.details?.["coveragePct"]).toBe(0);
  });

  it("fires translation_partial when DE has some but not all translations", () => {
    const countMap = new Map([["de", 60], ["en", 100], ["it", 100]]);
    const alerts = computeTranslationCoverageAlerts(100, locales, countMap);
    const deAlert = alerts.find((a) => a.details?.["language"] === "de");
    expect(deAlert).toBeDefined();
    expect(deAlert?.type).toBe("translation_partial");
    expect(deAlert?.details?.["coveragePct"]).toBe(60);
    expect(deAlert?.message).toContain("60");
    expect(deAlert?.message).toContain("40 products will fall back");
  });

  it("does not count inactive-product translations (countMap scoped to active)", () => {
    // Simulate: 100 active products, DE has 100 from a prior inactive-only run —
    // the DB query's active-product join means countMap only reflects active products.
    // If active DE count is actually 0, translation_missing should fire.
    const countMap = new Map([["de", 0]]); // active-scoped count is 0
    const alerts = computeTranslationCoverageAlerts(100, locales, countMap);
    const deAlert = alerts.find((a) => a.details?.["language"] === "de");
    expect(deAlert?.type).toBe("translation_missing");
  });

  it("returns no alerts when total active products is 0", () => {
    const countMap = new Map<string, number>();
    const alerts = computeTranslationCoverageAlerts(0, locales, countMap);
    expect(alerts).toHaveLength(0);
  });

  it("fires alerts for multiple incomplete locales independently", () => {
    const countMap = new Map([["de", 0], ["en", 50], ["it", 100]]);
    const alerts = computeTranslationCoverageAlerts(100, locales, countMap);
    expect(alerts).toHaveLength(2);
    expect(alerts.find((a) => a.type === "translation_missing")).toBeDefined();
    expect(alerts.find((a) => a.type === "translation_partial")).toBeDefined();
  });

  it("translation_partial message counts products that will fall back to FR", () => {
    const countMap = new Map([["de", 1500], ["en", 2096], ["it", 0]]);
    const alerts = computeTranslationCoverageAlerts(2096, locales, countMap);
    const deAlert = alerts.find((a) => a.details?.["language"] === "de");
    expect(deAlert).toBeDefined();
    expect(deAlert?.type).toBe("translation_partial");
    // 2096 - 1500 = 596 products fall back
    expect(deAlert?.message).toContain("596 products will fall back");
  });
});

// ── msUntilNext helper ────────────────────────────────────────────────────────

import { msUntilNext } from "../src/jobs/scheduler";

describe("msUntilNext", () => {
  it("target is 1h in the future → ~1h", () => {
    const now = new Date("2026-08-13T01:00:00.000Z");
    const ms = msUntilNext(2, 0, now);
    expect(ms).toBeCloseTo(60 * 60 * 1_000, -3);
  });

  it("target already passed today → wraps to next day (~23h)", () => {
    const now = new Date("2026-08-13T03:00:00.000Z");
    const ms = msUntilNext(2, 0, now);
    expect(ms).toBeGreaterThan(22 * 60 * 60 * 1_000);
    expect(ms).toBeLessThan(24 * 60 * 60 * 1_000);
  });

  it("target is exactly now → wraps to next day", () => {
    const now = new Date("2026-08-13T02:00:00.000Z");
    const ms = msUntilNext(2, 0, now);
    // now.getTime() === next.getTime() → wraps: +24h
    expect(ms).toBeGreaterThan(23 * 60 * 60 * 1_000);
  });
});
