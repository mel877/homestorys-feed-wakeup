import { describe, expect, it, vi } from "vitest";
import {
  runFullSyncPipeline,
  verifyFullSyncSnapshots,
  type FullSyncPipelineDependencies,
  type FullSyncSnapshotVerification,
} from "../src/jobs/full-sync-pipeline";

function verification(
  overrides: Partial<FullSyncSnapshotVerification> = {},
): FullSyncSnapshotVerification {
  return {
    ok: true,
    expectedRunId: "run-current",
    channels: {
      google: { ok: true, issues: [], snapshots: [] },
      meta: { ok: true, issues: [], snapshots: [] },
    },
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<FullSyncPipelineDependencies> = {},
): FullSyncPipelineDependencies {
  return {
    runFullSync: vi.fn().mockResolvedValue("run-current"),
    runGoogleExport: vi.fn().mockResolvedValue(undefined),
    runMetaExport: vi.fn().mockResolvedValue(undefined),
    withExportLock: vi.fn().mockImplementation(async (fn: () => Promise<void>) => fn()),
    verifySnapshots: vi.fn().mockResolvedValue(verification()),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("runFullSyncPipeline", () => {
  it("records a completed pipeline only when Google and Meta snapshots belong to the current Full Sync", async () => {
    const order: string[] = [];
    const deps = dependencies({
      runGoogleExport: vi.fn().mockImplementation(async () => {
        order.push("google");
      }),
      runMetaExport: vi.fn().mockImplementation(async () => {
        order.push("meta");
      }),
    });

    const result = await runFullSyncPipeline(deps);

    expect(order).toEqual(["google", "meta"]);
    expect(deps.runGoogleExport).toHaveBeenCalledWith({ syncRunId: "run-current" });
    expect(deps.runMetaExport).toHaveBeenCalledWith({ syncRunId: "run-current" });
    expect(deps.verifySnapshots).toHaveBeenCalledWith("run-current");
    expect(result.status).toBe("completed");
    expect(deps.recordOutcome).toHaveBeenCalledWith("run-current", result);
  });

  it("marks the Full Sync degraded when Meta exits successfully but its current snapshot belongs to an older run", async () => {
    const staleMetaVerification = verification({
      ok: false,
      channels: {
        google: { ok: true, issues: [], snapshots: [] },
        meta: {
          ok: false,
          issues: ["feeds/meta/meta-country-CH.csv belongs to run-previous"],
          snapshots: [{
            storagePath: "feeds/meta/meta-country-CH.csv",
            syncRunId: "run-previous",
            generatedAt: "2026-08-29T01:01:59.175Z",
            fallback: true,
          }],
        },
      },
    });
    const deps = dependencies({
      verifySnapshots: vi.fn().mockResolvedValue(staleMetaVerification),
    });

    const result = await runFullSyncPipeline(deps);

    expect(result.status).toBe("degraded");
    expect(result.channels.meta.status).toBe("fallback");
    expect(result.channels.meta.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("run-previous")]),
    );
    expect(result.channels.meta.snapshots[0]).toMatchObject({
      syncRunId: "run-previous",
      fallback: true,
    });
    expect(deps.recordOutcome).toHaveBeenCalledWith("run-current", result);
  });

  it("keeps the previous Meta snapshot as an explicit fallback when Meta generation fails", async () => {
    const deps = dependencies({
      runMetaExport: vi.fn().mockRejectedValue(new Error("Meta child exited with code 1")),
      verifySnapshots: vi.fn().mockResolvedValue(verification({
        ok: false,
        channels: {
          google: { ok: true, issues: [], snapshots: [] },
          meta: {
            ok: false,
            issues: ["Meta snapshot was not regenerated"],
            snapshots: [{
              storagePath: "feeds/meta/meta-country-CH.csv",
              syncRunId: "run-previous",
              generatedAt: "2026-08-29T01:01:59.175Z",
              fallback: true,
            }],
          },
        },
      })),
    });

    const result = await runFullSyncPipeline(deps);

    expect(result.status).toBe("degraded");
    expect(result.channels.meta.status).toBe("fallback");
    expect(result.channels.meta.error).toContain("Meta child exited with code 1");
    expect(deps.verifySnapshots).toHaveBeenCalledWith("run-current");
    expect(deps.recordOutcome).toHaveBeenCalledWith("run-current", result);
  });
});

describe("verifyFullSyncSnapshots", () => {
  it("rejects an old current snapshot and exposes it as the explicit fallback", async () => {
    const result = await verifyFullSyncSnapshots("run-current", {
      expectedPaths: () => ({
        google: ["feeds/google/google-de-CH_DE.tsv"],
        meta: ["feeds/meta/meta-country-CH.csv"],
      }),
      listCurrentSnapshots: vi.fn().mockResolvedValue([
        {
          channel: "google",
          storagePath: "feeds/google/google-de-CH_DE.tsv",
          syncRunId: "run-current",
          sha256: "google-sha",
          generatedAt: new Date("2026-08-29T02:00:00Z"),
        },
        {
          channel: "meta",
          storagePath: "feeds/meta/meta-country-CH.csv",
          syncRunId: "run-previous",
          sha256: "meta-sha",
          generatedAt: new Date("2026-08-29T01:00:00Z"),
        },
      ]),
      loadManifest: vi.fn().mockImplementation(async (path: string) => ({
        version: "2026-08-29",
        generatedAt: "2026-08-29T02:00:00Z",
        itemCount: 1,
        sha256: path.includes("google") ? "google-sha" : "meta-sha",
        sourceRunId: path.includes("google") ? "run-current" : "run-previous",
        channel: path.includes("google") ? "google" : "meta",
        language: "de",
        marketCode: "CH",
      })),
    });

    expect(result.ok).toBe(false);
    expect(result.channels.google.ok).toBe(true);
    expect(result.channels.meta.ok).toBe(false);
    expect(result.channels.meta.snapshots[0]).toMatchObject({
      syncRunId: "run-previous",
      fallback: true,
    });
  });

  it("rejects a current DB snapshot when its manifest has another source run", async () => {
    const result = await verifyFullSyncSnapshots("run-current", {
      expectedPaths: () => ({ google: [], meta: ["feeds/meta/meta-country-CH.csv"] }),
      listCurrentSnapshots: vi.fn().mockResolvedValue([{
        channel: "meta",
        storagePath: "feeds/meta/meta-country-CH.csv",
        syncRunId: "run-current",
        sha256: "meta-sha",
        generatedAt: new Date("2026-08-29T02:00:00Z"),
      }]),
      loadManifest: vi.fn().mockResolvedValue({
        version: "2026-08-29",
        generatedAt: "2026-08-29T01:00:00Z",
        itemCount: 1,
        sha256: "meta-sha",
        sourceRunId: "run-previous",
        channel: "meta",
        language: "de",
        marketCode: "CH",
      }),
    });

    expect(result.channels.meta.ok).toBe(false);
    expect(result.channels.meta.issues).toEqual([
      expect.stringContaining("manifest belongs to run-previous"),
    ]);
  });
});