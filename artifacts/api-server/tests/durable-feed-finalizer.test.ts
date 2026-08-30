import { describe, expect, it, vi } from "vitest";
import { durableFeedFinalizerTestHooks } from "../src/exporters/durable-feed-finalizer";
const finalizeDurableFeedFile = durableFeedFinalizerTestHooks!.finalizeDurableFeedFile;
const resolveSnapshotMarketCode = durableFeedFinalizerTestHooks!.resolveSnapshotMarketCode;

const base = {
  syncRunId: "run-1",
  channel: "google" as const,
  language: "fr",
  marketCode: "BE_FR",
  version: "v1",
  currentPath: "feeds/google/google-fr-BE_FR.tsv",
  versionedPath: "feeds/google/versions/v1/google-fr-BE_FR.tsv",
  headers: ["id", "price"],
  delimiter: "\t" as const,
  requiredBatchIndexes: [0, 1],
  parts: [
    { batchIndex: 0, artifactPath: "part-0", status: "completed" },
    { batchIndex: 1, artifactPath: "part-1", status: "completed" },
  ],
  maxDropPct: 20,
  dryRun: false,
};

describe("durable feed finalizer", () => {
  it("uses a dedicated snapshot identity for durable Meta language layers", () => {
    expect(resolveSnapshotMarketCode({
      channel: "meta",
      fileKey: "meta-language-fr",
      language: "fr",
      marketCode: "LANG_FR",
    })).toBe("META_LANGUAGE_FR");
    expect(resolveSnapshotMarketCode({
      channel: "meta",
      fileKey: "meta-language-de",
      language: "de",
      marketCode: "LANG_DE",
    })).toBe("META_LANGUAGE_DE");
  });

  it("keeps existing snapshot identities for Google and other Meta layers", () => {
    expect(resolveSnapshotMarketCode({
      channel: "meta",
      fileKey: "meta-country-BE",
      language: "",
      marketCode: "BE",
    })).toBe("BE");
    expect(resolveSnapshotMarketCode({
      channel: "google",
      fileKey: "google-language-fr",
      language: "fr",
      marketCode: "LANG_FR",
    })).toBe("LANG_FR");
  });

  it("does not publish or replace a snapshot when validation fails", async () => {
    const publish = vi.fn();
    const recordSnapshot = vi.fn();
    const result = await finalizeDurableFeedFile(base, {
      assemble: vi.fn().mockResolvedValue({
        sha256: "sha",
        bytes: 100,
        itemCount: 2,
      }),
      uploadManifest: vi.fn(),
      validate: vi.fn().mockResolvedValue({ valid: false, errors: ["bad price"] }),
      loadPreviousItemCount: vi.fn().mockResolvedValue(10),
      publish,
      recordSnapshot,
    });

    expect(result).toMatchObject({ status: "blocked", published: false });
    expect(publish).not.toHaveBeenCalled();
    expect(recordSnapshot).not.toHaveBeenCalled();
  });

  it("records a current snapshot only after atomic publication succeeds", async () => {
    const order: string[] = [];
    const recordSnapshot = vi.fn(async () => { order.push("snapshot"); });
    const result = await finalizeDurableFeedFile(base, {
      assemble: vi.fn(async () => {
        order.push("assemble");
        return { sha256: "sha", bytes: 100, itemCount: 2 };
      }),
      uploadManifest: vi.fn(async () => { order.push("manifest"); }),
      validate: vi.fn(async () => {
        order.push("validate");
        return { valid: true, errors: [] };
      }),
      loadPreviousItemCount: vi.fn().mockResolvedValue(2),
      publish: vi.fn(async () => {
        order.push("publish");
        return true;
      }),
      recordSnapshot,
    });

    expect(result).toMatchObject({ status: "published", published: true });
    expect(order).toEqual(["assemble", "manifest", "validate", "publish", "snapshot"]);
    expect(recordSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: "feeds/google/versions/v1/google-fr-BE_FR.tsv",
    }));
  });

  it("retains the previous snapshot when the existing guardrail blocks publication", async () => {
    const recordSnapshot = vi.fn();
    const result = await finalizeDurableFeedFile(base, {
      assemble: vi.fn().mockResolvedValue({
        sha256: "sha",
        bytes: 100,
        itemCount: 2,
      }),
      uploadManifest: vi.fn(),
      validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
      loadPreviousItemCount: vi.fn().mockResolvedValue(100),
      publish: vi.fn().mockResolvedValue(false),
      recordSnapshot,
    });

    expect(result).toMatchObject({ status: "blocked", published: false });
    expect(recordSnapshot).not.toHaveBeenCalled();
  });
});