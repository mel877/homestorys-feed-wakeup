/**
 * Tests for src/lib/storage.ts
 *
 * Tests the pure helper functions (path builders, formatVersionTs).
 * GCS operations are NOT tested here as they require live credentials.
 */

import { describe, it, expect } from "vitest";
import {
  googleFeedPath,
  metaFeedPath,
  versionedPath,
  formatVersionTs,
} from "../src/lib/storage";

describe("googleFeedPath", () => {
  it("returns correct path for fr + BE_FR", () => {
    expect(googleFeedPath("fr", "BE_FR")).toBe("feeds/google/google-fr-BE_FR.tsv");
  });

  it("returns correct path for de + DE", () => {
    expect(googleFeedPath("de", "DE")).toBe("feeds/google/google-de-DE.tsv");
  });

  it("returns correct path for de + AT", () => {
    expect(googleFeedPath("de", "AT")).toBe("feeds/google/google-de-AT.tsv");
  });
});

describe("metaFeedPath", () => {
  it("returns correct path for base CSV", () => {
    expect(metaFeedPath("meta-base.csv")).toBe("feeds/meta/meta-base.csv");
  });

  it("returns correct path for language CSV", () => {
    expect(metaFeedPath("meta-language-fr.csv")).toBe("feeds/meta/meta-language-fr.csv");
  });

  it("returns correct path for country CSV", () => {
    expect(metaFeedPath("meta-country-BE.csv")).toBe("feeds/meta/meta-country-BE.csv");
  });
});

describe("versionedPath", () => {
  it("inserts versions/{ts} before filename", () => {
    const result = versionedPath("feeds/google/google-fr-BE_FR.tsv", "2024-01-16T08-00-00");
    expect(result).toBe("feeds/google/versions/2024-01-16T08-00-00/google-fr-BE_FR.tsv");
  });

  it("works for meta feed paths", () => {
    const result = versionedPath("feeds/meta/meta-base.csv", "2024-01-16T08-00-00");
    expect(result).toBe("feeds/meta/versions/2024-01-16T08-00-00/meta-base.csv");
  });

  it("preserves subdirectory structure", () => {
    const result = versionedPath("feeds/google/google-de-AT.tsv", "ts123");
    expect(result).toContain("feeds/google/versions/ts123/google-de-AT.tsv");
  });
});

describe("formatVersionTs", () => {
  it("returns an ISO-like string without colons or dots", () => {
    const ts = formatVersionTs(new Date("2024-06-15T14:30:45.123Z"));
    expect(ts).not.toContain(":");
    expect(ts).not.toContain(".");
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });

  it("produces consistent length output", () => {
    const ts = formatVersionTs(new Date("2024-01-01T00:00:00.000Z"));
    expect(ts.length).toBe(19);
  });
});
