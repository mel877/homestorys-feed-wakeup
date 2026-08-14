/**
 * Unit tests for atomicPublish in src/lib/storage.ts
 *
 * GCS is fully mocked — these tests exercise the gate logic only:
 *   1. Item-count drop exceeding threshold → blocked (returns false, no copy)
 *   2. First publish (no previous snapshot) → always succeeds (returns true)
 *   3. Item-count drop within threshold → succeeds (returns true)
 *   4. Item count increases → succeeds (returns true)
 *   5. Drop exactly at threshold → succeeds (returns true, boundary-inclusive)
 *   6. Drop one percentage point above threshold → blocked
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── GCS mock ──────────────────────────────────────────────────────────────────
//
// atomicPublish calls getBucket() → storageClient.bucket().
// Use vi.hoisted() so the variables are available inside the vi.mock factory.

const { mockCopy, mockFile, mockBucket } = vi.hoisted(() => {
  const mockCopy = vi.fn().mockResolvedValue(undefined);
  const mockFile = vi.fn().mockReturnValue({ copy: mockCopy });
  const mockBucket = vi.fn().mockReturnValue({ file: mockFile });
  return { mockCopy, mockFile, mockBucket };
});

vi.mock("@google-cloud/storage", () => ({
  Storage: vi.fn().mockImplementation(() => ({
    bucket: mockBucket,
  })),
}));

// Provide the env var that getBucket() reads
process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"] = "test-bucket";

import { atomicPublish } from "../src/lib/storage";
import type { FeedManifest } from "../src/lib/storage";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeManifest(itemCount: number): FeedManifest {
  return {
    version: "2024-06-01T12-00-00",
    generatedAt: new Date().toISOString(),
    itemCount,
    sha256: "abc123",
    sourceRunId: null,
    channel: "meta",
    language: null,
    marketCode: null,
  };
}

const BASE_PARAMS = {
  versionedPath: "feeds/meta/versions/2024-06-01T12-00-00/meta-base.csv",
  currentPath: "feeds/meta/meta-base.csv",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire the file mock after clearAllMocks resets mockCopy's implementation
  mockCopy.mockResolvedValue(undefined);
  mockFile.mockReturnValue({ copy: mockCopy });
  mockBucket.mockReturnValue({ file: mockFile });
});

describe("atomicPublish — drop-percentage gate", () => {
  it("blocks publish when item count drops more than maxDropPct", async () => {
    // Previous: 1000 items, new: 800 items → 20% drop; threshold 10%
    const result = await atomicPublish({
      ...BASE_PARAMS,
      manifest: makeManifest(800),
      previousItemCount: 1000,
      maxDropPct: 10,
    });

    expect(result).toBe(false);
    // No copy should have been issued
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it("blocks publish when drop is exactly one point above threshold", async () => {
    // Previous: 100, new: 89 → 11% drop; threshold 10%
    const result = await atomicPublish({
      ...BASE_PARAMS,
      manifest: makeManifest(89),
      previousItemCount: 100,
      maxDropPct: 10,
    });

    expect(result).toBe(false);
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it("allows publish when item count drop equals threshold (boundary-inclusive)", async () => {
    // Previous: 100, new: 90 → exactly 10% drop; threshold 10%
    // dropPct === maxDropPct is NOT > maxDropPct, so gate passes
    const result = await atomicPublish({
      ...BASE_PARAMS,
      manifest: makeManifest(90),
      previousItemCount: 100,
      maxDropPct: 10,
    });

    expect(result).toBe(true);
    expect(mockCopy).toHaveBeenCalled();
  });

  it("allows publish when drop is within threshold", async () => {
    // Previous: 1000, new: 950 → 5% drop; threshold 10%
    const result = await atomicPublish({
      ...BASE_PARAMS,
      manifest: makeManifest(950),
      previousItemCount: 1000,
      maxDropPct: 10,
    });

    expect(result).toBe(true);
    expect(mockCopy).toHaveBeenCalled();
  });

  it("allows publish when item count increases", async () => {
    const result = await atomicPublish({
      ...BASE_PARAMS,
      manifest: makeManifest(1200),
      previousItemCount: 1000,
      maxDropPct: 10,
    });

    expect(result).toBe(true);
    expect(mockCopy).toHaveBeenCalled();
  });
});

describe("atomicPublish — first publish (no previous snapshot)", () => {
  it("succeeds when previousItemCount is null", async () => {
    const result = await atomicPublish({
      ...BASE_PARAMS,
      manifest: makeManifest(500),
      previousItemCount: null,
      maxDropPct: 10,
    });

    expect(result).toBe(true);
    expect(mockCopy).toHaveBeenCalled();
  });

  it("succeeds even with zero items on first publish", async () => {
    // Edge case: empty first catalog — gate should pass because there is no
    // previous snapshot to compare against.
    const result = await atomicPublish({
      ...BASE_PARAMS,
      manifest: makeManifest(0),
      previousItemCount: null,
      maxDropPct: 10,
    });

    expect(result).toBe(true);
    expect(mockCopy).toHaveBeenCalled();
  });

  it("succeeds when previousItemCount is 0 (previously empty catalog)", async () => {
    // previousItemCount === 0 skips the drop check (division-by-zero guard).
    const result = await atomicPublish({
      ...BASE_PARAMS,
      manifest: makeManifest(0),
      previousItemCount: 0,
      maxDropPct: 10,
    });

    expect(result).toBe(true);
    expect(mockCopy).toHaveBeenCalled();
  });
});

describe("atomicPublish — GCS copy behaviour", () => {
  it("copies both the feed file and its manifest to the current path", async () => {
    const versioned = "feeds/meta/versions/2024-06-01T12-00-00/meta-base.csv";
    const current = "feeds/meta/meta-base.csv";

    await atomicPublish({
      versionedPath: versioned,
      currentPath: current,
      manifest: makeManifest(100),
      previousItemCount: 100,
      maxDropPct: 10,
    });

    // file() should be called for both the data file and its manifest
    const fileArgs = mockFile.mock.calls.map((c) => c[0] as string);

    expect(fileArgs).toContain(versioned);
    expect(fileArgs).toContain(`${versioned}.manifest.json`);
  });
});
