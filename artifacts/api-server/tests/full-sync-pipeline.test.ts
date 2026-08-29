import { describe, expect, it, vi } from "vitest";
import {
  expectedFullSyncSnapshotPaths,
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
  it("completes when every snapshot configured for the current feed architecture belongs to the Full Sync", async () => {
    const expectedPaths = expectedFullSyncSnapshotPaths({
      markets: {
        CH_DE: { country: "CH", language: "de" },
        CH_FR: { country: "CH", language: "fr" },
        LU_DE: { country: "LU", language: "de" },
      },
    });
    const configuredPaths = [...expectedPaths.google, ...expectedPaths.meta];
    const result = await verifyFullSyncSnapshots("run-current", {
      expectedPaths: () => expectedPaths,
      listCurrentSnapshots: vi.fn().mockResolvedValue([
        ...configuredPaths.map((storagePath) => ({
          channel: storagePath.includes("/google/") ? "google" : "meta",
          storagePath,
          syncRunId: "run-current",
          sha256: `${storagePath}-sha`,
          generatedAt: new Date("2026-08-29T02:00:00Z"),
        })),
        {
          channel: "meta",
          storagePath: "feeds/meta/meta-country-BE.csv",
          syncRunId: null,
          sha256: "historical-be-sha",
          generatedAt: new Date("2026-08-14T11:08:26Z"),
        },
      ]),
      loadManifest: vi.fn().mockImplementation(async (storagePath: string) => ({
        version: "2026-08-29",
        generatedAt: "2026-08-29T02:00:00Z",
        itemCount: 1,
        sha256: `${storagePath}-sha`,
        sourceRunId: "run-current",
        channel: storagePath.includes("/google/") ? "google" : "meta",
        language: null,
        marketCode: null,
      })),
    });

    expect(expectedPaths).toEqual({
      google: [
        "feeds/google/google-de-CH_DE.tsv",
        "feeds/google/google-fr-CH_FR.tsv",
        "feeds/google/google-de-LU_DE.tsv",
        "feeds/google/google-de.tsv",
        "feeds/google/google-fr.tsv",
      ],
      meta: [
        "feeds/meta/meta-base.csv",
        "feeds/meta/meta-language-de.csv",
        "feeds/meta/meta-language-fr.csv",
        "feeds/meta/meta-country-CH.csv",
        "feeds/meta/meta-country-LU.csv",
        "feeds/meta/meta-de.csv",
        "feeds/meta/meta-fr.csv",
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.channels.google.ok).toBe(true);
    expect(result.channels.meta.ok).toBe(true);
    expect(result.channels.meta.snapshots).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ storagePath: "feeds/meta/meta-country-BE.csv" }),
      ]),
    );
  });

  it("keeps public de/fr aggregates required without inventing a Meta language layer", async () => {
    const expectedPaths = expectedFullSyncSnapshotPaths({
      markets: {
        DE: { country: "DE", language: "de" },
      },
    });
    const configuredPaths = [...expectedPaths.google, ...expectedPaths.meta];
    const result = await verifyFullSyncSnapshots("run-current", {
      expectedPaths: () => expectedPaths,
      listCurrentSnapshots: vi.fn().mockResolvedValue(
        configuredPaths.map((storagePath) => ({
          channel: storagePath.includes("/google/") ? "google" : "meta",
          storagePath,
          syncRunId: "run-current",
          sha256: `${storagePath}-sha`,
          generatedAt: new Date("2026-08-29T02:00:00Z"),
        })),
      ),
      loadManifest: vi.fn().mockImplementation(async (storagePath: string) => ({
        version: "2026-08-29",
        generatedAt: "2026-08-29T02:00:00Z",
        itemCount: 1,
        sha256: `${storagePath}-sha`,
        sourceRunId: "run-current",
        channel: storagePath.includes("/google/") ? "google" : "meta",
        language: null,
        marketCode: null,
      })),
    });

    expect(expectedPaths).toEqual({
      google: [
        "feeds/google/google-de-DE.tsv",
        "feeds/google/google-de.tsv",
        "feeds/google/google-fr.tsv",
      ],
      meta: [
        "feeds/meta/meta-base.csv",
        "feeds/meta/meta-language-de.csv",
        "feeds/meta/meta-country-DE.csv",
        "feeds/meta/meta-de.csv",
        "feeds/meta/meta-fr.csv",
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects the Full Sync when a configured feed has no current snapshot", async () => {
    const result = await verifyFullSyncSnapshots("run-current", {
      expectedPaths: () => ({
        google: ["feeds/google/google-de.tsv"],
        meta: ["feeds/meta/meta-de.csv"],
      }),
      listCurrentSnapshots: vi.fn().mockResolvedValue([{
        channel: "google",
        storagePath: "feeds/google/google-de.tsv",
        syncRunId: "run-current",
        sha256: "google-sha",
        generatedAt: new Date("2026-08-29T02:00:00Z"),
      }]),
      loadManifest: vi.fn().mockResolvedValue({
        version: "2026-08-29",
        generatedAt: "2026-08-29T02:00:00Z",
        itemCount: 1,
        sha256: "google-sha",
        sourceRunId: "run-current",
        channel: "google",
        language: "de",
        marketCode: null,
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.channels.google.ok).toBe(true);
    expect(result.channels.meta).toMatchObject({
      ok: false,
      issues: ["feeds/meta/meta-de.csv has no current snapshot"],
      snapshots: [],
    });
  });

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