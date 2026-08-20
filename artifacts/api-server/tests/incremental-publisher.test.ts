/**
 * Regression coverage for Shopify webhook URL-feed publishing.
 *
 * The publisher rehydrates only changed product cache rows, but every public
 * language URL must remain a complete catalog. These tests run the publisher
 * against an in-memory Drizzle/storage boundary so the cache, snapshot, and
 * serialized URL files are exercised together.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { stringify } from "csv-stringify/sync";

const {
  state,
  mockAtomicPublish,
  mockDownloadFeedFile,
  mockDownloadManifest,
  mockProcessAllCanonicals,
  mockRunGoogleExport,
  mockRunMetaExport,
  mockUploadFeedFile,
  mockUploadManifest,
  db,
  feedItemsTable,
  feedSnapshotsTable,
  variantsTable,
} = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    variants: [] as Row[],
    feedItems: [] as Row[],
    sourceRows: [] as Row[],
    snapshots: [] as Row[],
    files: new Map<string, string>(),
    manifests: new Map<string, Row>(),
    blockPublishes: false,
  };

  function matches(row: Row, condition: unknown): boolean {
    if (!condition || typeof condition !== "object") return true;
    const expression = condition as { op?: string; field?: string; value?: unknown; conditions?: unknown[] };
    if (expression.op === "and") return (expression.conditions ?? []).every((part) => matches(row, part));
    if (expression.op === "eq") return row[expression.field!] === expression.value;
    if (expression.op === "in") return (expression.value as unknown[]).includes(row[expression.field!]);
    return true;
  }

  function queryRows(rows: Row[], projection?: Record<string, string>) {
    const projected = projection
      ? rows.map((row) => Object.fromEntries(Object.entries(projection).map(([key, field]) => [key, row[field]])))
      : rows;
    return Object.assign(projected, {
      limit: vi.fn((count: number) => projected.slice(0, count)),
    });
  }

  const feedItemsTable = {
    variantId: "variantId",
    marketCode: "marketCode",
    language: "language",
    channel: "channel",
    canonicalJson: "canonicalJson",
    isEligible: "isEligible",
  };
  const feedSnapshotsTable = {
    id: "id",
    channel: "channel",
    language: "language",
    marketCode: "marketCode",
    isCurrent: "isCurrent",
    itemCount: "itemCount",
  };
  const variantsTable = { id: "id", productId: "productId" };

  const db = {
    select: vi.fn((projection?: Record<string, string>) => ({
      from: (table: object) => ({
        where: (condition: unknown) => {
          const rows = table === variantsTable
            ? state.variants
            : table === feedItemsTable
              ? state.feedItems
              : table === feedSnapshotsTable
                ? state.snapshots
                : [];
          return queryRows(rows.filter((row) => matches(row, condition)), projection);
        },
      }),
    })),
    delete: vi.fn((table: object) => ({
      where: async (condition: unknown) => {
        if (table === feedItemsTable) {
          state.feedItems = state.feedItems.filter((row) => !matches(row, condition));
        }
      },
    })),
    update: vi.fn((table: object) => ({
      set: (values: Row) => ({
        where: async (condition: unknown) => {
          if (table === feedSnapshotsTable) {
            state.snapshots = state.snapshots.map((row) =>
              matches(row, condition) ? { ...row, ...values } : row,
            );
          }
        },
      }),
    })),
    insert: vi.fn((table: object) => ({
      values: async (values: Row) => {
        if (table === feedSnapshotsTable) {
          state.snapshots.push({ id: `snapshot-${state.snapshots.length + 1}`, ...values });
        }
      },
    })),
  };

  return {
    state,
    mockAtomicPublish: vi.fn(),
    mockDownloadFeedFile: vi.fn(),
    mockDownloadManifest: vi.fn(),
    mockProcessAllCanonicals: vi.fn(),
    mockRunGoogleExport: vi.fn(),
    mockRunMetaExport: vi.fn(),
    mockUploadFeedFile: vi.fn(),
    mockUploadManifest: vi.fn(),
    db,
    feedItemsTable,
    feedSnapshotsTable,
    variantsTable,
  };
});

// Keep the database mock in one factory: table identity is how the small
// in-memory query boundary knows which collection to query.
vi.mock("@workspace/db", () => ({
  db,
  feedItemsTable,
  feedSnapshotsTable,
  variantsTable,
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ op: "and", conditions }),
  eq: (field: string, value: unknown) => ({ op: "eq", field, value }),
  inArray: (field: string, value: unknown[]) => ({ op: "in", field, value }),
  sql: () => ({ op: "all" }),
}));

vi.mock("../src/config/loader", () => ({
  loadConfig: () => ({
    markets: {
      language_masters: {
        fr: { markets: ["BE_FR"] },
        de: { markets: ["BE_DE"] },
      },
    },
    feedPolicy: { snapshot_gate: { max_item_count_drop_pct: 75 } },
  }),
}));

vi.mock("../src/exporters/export-lock", () => ({
  withExportLock: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../src/exporters/dry-run", () => ({
  resolveGoogleDryRun: () => false,
  resolveMetaDryRun: () => false,
}));

vi.mock("../src/exporters/canonical-reader", () => ({
  processAllCanonicals: mockProcessAllCanonicals,
}));

vi.mock("../src/exporters/google/mapper", () => ({
  buildGoogleTsv: (rows: Array<Record<string, unknown>>) => JSON.stringify(rows),
  mapToGoogleRow: (canonical: Record<string, unknown>) => canonical,
}));

vi.mock("../src/exporters/meta/mapper", () => ({
  META_BASE_HEADERS: ["id", "title"],
  META_LANGUAGE_HEADERS: ["id"],
  META_COUNTRY_HEADERS: ["id"],
  mapToMeta: (canonical: Record<string, unknown>) => ({
    base: { id: canonical.id, title: canonical.title },
    language_row: { id: canonical.id },
    country_row: { id: canonical.id },
  }),
}));

vi.mock("../src/validation/feed-validator", () => ({
  validateGoogleFeed: vi.fn().mockResolvedValue({ valid: true, errorCount: 0 }),
  validateMetaFeed: vi.fn().mockResolvedValue({ valid: true, errorCount: 0 }),
}));

vi.mock("../src/lib/storage", () => ({
  atomicPublish: mockAtomicPublish,
  downloadFeedFile: mockDownloadFeedFile,
  downloadManifest: mockDownloadManifest,
  formatVersionTs: () => "2026-08-20T12-00-00",
  googleLanguageFeedPath: (language: string) => `google-${language}`,
  metaLanguageFeedPath: (language: string) => `meta-${language}`,
  uploadFeedFile: mockUploadFeedFile,
  uploadManifest: mockUploadManifest,
  versionedPath: (path: string, version: string) => `${path}/${version}`,
}));

vi.mock("../src/exporters/google/runner", () => ({
  runGoogleExport: mockRunGoogleExport,
}));

vi.mock("../src/exporters/meta/generator", () => ({
  runMetaExport: mockRunMetaExport,
}));

vi.mock("../src/exporters/meta/fresh-process", () => ({
  runMetaExportInFreshProcess: mockRunMetaExport,
}));

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function languageForMarket(marketCode: string): string {
  return marketCode === "BE_FR" ? "fr" : "de";
}

function rowsFor(channel: string, language: string, rows = state.feedItems): Array<Record<string, unknown>> {
  return rows
    .filter((row) => row.channel === channel && row.language === language && row.isEligible)
    .map((row) => row.canonicalJson as Record<string, unknown>);
}

function serialized(channel: string, language: string, rows = state.feedItems): string {
  const rowsForLanguage = rowsFor(channel, language, rows)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (channel === "google") return JSON.stringify(rowsForLanguage);
  return stringify(
    rowsForLanguage.map((canonical) => ({ id: canonical.id, title: canonical.title })),
    { header: true, columns: ["id", "title"] },
  );
}

function currentPath(channel: string, language: string): string {
  return channel === "google" ? `google-${language}` : `meta-${language}`;
}

function seedCurrentCatalog(rows = state.feedItems): void {
  state.snapshots = [];
  for (const channel of ["google", "meta"]) {
    for (const language of ["fr", "de"]) {
      const content = serialized(channel, language, rows);
      const path = currentPath(channel, language);
      state.files.set(path, content);
      state.manifests.set(path, {
        itemCount: rowsFor(channel, language, rows).length,
        sha256: hash(content),
      });
      state.snapshots.push({
        id: `${channel}-${language}`,
        channel,
        language,
        marketCode: `LANG_${language.toUpperCase()}`,
        itemCount: rowsFor(channel, language, rows).length,
        isCurrent: true,
      });
    }
  }
}

function cacheRows(productId: string, variantId: string, title: string): Array<Record<string, unknown>> {
  return ["google", "meta"].flatMap((channel) =>
    ["BE_FR", "BE_DE"].map((marketCode) => {
      const language = languageForMarket(marketCode);
      return {
        productId,
        variantId,
        channel,
        marketCode,
        language,
        isEligible: true,
        canonicalJson: {
          id: `${channel}-${language}-${variantId}`,
          title,
        },
      };
    }),
  );
}

function setCatalog(options?: { includeRemovedVariant?: boolean }): void {
  const changed = cacheRows("product-changed", "variant-changed", "Before update");
  const unrelated = cacheRows("product-unrelated", "variant-unrelated", "Unrelated product");
  const removed = options?.includeRemovedVariant
    ? cacheRows("product-variant", "variant-removed", "Removed variant")
    : [];
  const remaining = options?.includeRemovedVariant
    ? cacheRows("product-variant", "variant-remaining", "Remaining variant")
    : [];

  state.variants = [
    { id: "variant-changed", productId: "product-changed" },
    { id: "variant-unrelated", productId: "product-unrelated" },
    ...removed.map((row) => ({ id: row.variantId, productId: row.productId })),
    ...remaining.map((row) => ({ id: row.variantId, productId: row.productId })),
  ].filter((value, index, values) => values.findIndex((other) => other.id === value.id) === index);
  state.feedItems = [...changed, ...unrelated, ...removed, ...remaining];
  state.sourceRows = [...state.feedItems];
  seedCurrentCatalog();
}

function content(channel: string, language: string): string {
  return state.files.get(currentPath(channel, language)) ?? "";
}

beforeEach(() => {
  state.variants = [];
  state.feedItems = [];
  state.sourceRows = [];
  state.snapshots = [];
  state.files.clear();
  state.manifests.clear();
  state.blockPublishes = false;
  vi.clearAllMocks();

  mockDownloadManifest.mockImplementation(async (path: string) => state.manifests.get(path) ?? null);
  mockDownloadFeedFile.mockImplementation(async (path: string) => {
    const file = state.files.get(path);
    return file === undefined ? null : Buffer.from(file);
  });
  mockUploadFeedFile.mockImplementation(async (path: string, file: string | Buffer) => {
    const content = Buffer.isBuffer(file) ? file.toString("utf8") : file;
    state.files.set(path, content);
    return hash(content);
  });
  mockUploadManifest.mockImplementation(async (path: string, manifest: Record<string, unknown>) => {
    state.manifests.set(path, manifest);
  });
  mockAtomicPublish.mockImplementation(async (params: {
    versionedPath: string;
    currentPath: string;
    manifest: Record<string, unknown>;
  }) => {
    if (state.blockPublishes) return false;
    state.files.set(params.currentPath, state.files.get(params.versionedPath)!);
    state.manifests.set(params.currentPath, params.manifest);
    return true;
  });
  mockProcessAllCanonicals.mockImplementation(async (
    _config: unknown,
    options: { channel: string; productIds?: string[] },
  ) => {
    const productIds = options.productIds ? new Set(options.productIds) : null;
    const activeVariants = new Set(
      state.variants
        .filter((variant) => !productIds || productIds.has(String(variant.productId)))
        .map((variant) => String(variant.id)),
    );
    state.feedItems.push(
      ...state.sourceRows.filter(
        (row) => row.channel === options.channel && activeVariants.has(String(row.variantId)),
      ),
    );
  });
  // The Google full exporter writes Google cache rows. Meta's full URL export
  // produces the public files but its language pass intentionally does not
  // persist a Meta cache; bootstrap must invoke processAllCanonicals for it.
  mockRunGoogleExport.mockImplementation(async () => {
    state.feedItems.push(...state.sourceRows.filter((row) => row.channel === "google"));
    return { byMarket: {} };
  });
  mockRunMetaExport.mockImplementation(async () => {
    seedCurrentCatalog(state.sourceRows);
    return { files: {} };
  });
});

describe("incremental Shopify URL-feed publishing", () => {
  it("updates FR and DE Google/Meta rows while retaining unrelated cached catalog rows", async () => {
    setCatalog();
    state.sourceRows = state.sourceRows.map((row) =>
      row.variantId === "variant-changed"
        ? { ...row, canonicalJson: { ...(row.canonicalJson as Record<string, unknown>), title: "After update" } }
        : row,
    );

    const { publishProductChanges } = await import("../src/exporters/incremental-publisher");
    await publishProductChanges(["product-changed"]);

    for (const channel of ["google", "meta"]) {
      for (const language of ["fr", "de"]) {
        const published = content(channel, language);
        expect(published).toContain("After update");
        expect(published).toContain("Unrelated product");
        expect(published).not.toContain("Before update");
      }
    }
    expect(mockAtomicPublish).toHaveBeenCalledTimes(4);
  });

  it("removes product rows from every public language catalog", async () => {
    setCatalog();
    state.sourceRows = state.sourceRows.filter((row) => row.productId !== "product-changed");

    const { publishProductChanges } = await import("../src/exporters/incremental-publisher");
    await publishProductChanges(["product-changed"]);

    for (const channel of ["google", "meta"]) {
      for (const language of ["fr", "de"]) {
        const published = content(channel, language);
        expect(published).not.toContain("variant-changed");
        expect(published).toContain("variant-unrelated");
      }
    }
  });

  it("removes a deleted variant without dropping its sibling or unrelated products", async () => {
    setCatalog({ includeRemovedVariant: true });
    state.variants = state.variants.filter((variant) => variant.id !== "variant-removed");
    // Deleting a variant cascades its feed_items rows in Postgres.
    state.feedItems = state.feedItems.filter((row) => row.variantId !== "variant-removed");
    state.sourceRows = state.sourceRows.filter((row) => row.variantId !== "variant-removed");
    // The cache no longer matches the old URL file after the cascade, so the
    // publisher must take its safe full-reconciliation path before publishing.
    mockRunGoogleExport.mockImplementationOnce(async () => {
      state.feedItems.push(...state.sourceRows.filter((row) => row.channel === "google"));
      return { byMarket: {} };
    });

    const { publishProductChanges } = await import("../src/exporters/incremental-publisher");
    await publishProductChanges(["product-variant"]);

    for (const channel of ["google", "meta"]) {
      for (const language of ["fr", "de"]) {
        const published = content(channel, language);
        expect(published).not.toContain("variant-removed");
        expect(published).toContain("variant-remaining");
        expect(published).toContain("variant-unrelated");
      }
    }
  });

  it("uses the full URL-only reconciliation path when the cache no longer matches the current catalog", async () => {
    setCatalog();
    state.feedItems = state.feedItems.filter(
      (row) => !(row.channel === "google" && row.language === "fr" && row.variantId === "variant-changed"),
    );
    mockRunGoogleExport.mockImplementationOnce(async () => {
      state.feedItems.push(...state.sourceRows.filter((row) => row.channel === "google"));
      return { byMarket: {} };
    });

    const { publishProductChanges } = await import("../src/exporters/incremental-publisher");
    await publishProductChanges(["product-changed"]);

    expect(mockRunGoogleExport).toHaveBeenCalledWith({ skipGoogleApi: true });
    expect(mockRunMetaExport).toHaveBeenCalledWith();
    expect(mockProcessAllCanonicals).toHaveBeenCalledWith(
      expect.anything(),
      { channel: "meta", persistFeedItems: true },
      expect.any(Function),
    );
    expect(content("google", "fr")).toContain("variant-changed");
    expect(state.feedItems.filter((row) => row.channel === "meta")).toHaveLength(4);
  });

  it("fails when an incremental publication is blocked so the webhook can retry", async () => {
    setCatalog();
    state.blockPublishes = true;

    const { publishProductChanges, IncrementalFeedPublicationBlockedError } = await import(
      "../src/exporters/incremental-publisher"
    );

    await expect(publishProductChanges(["product-changed"])).rejects.toBeInstanceOf(
      IncrementalFeedPublicationBlockedError,
    );
    expect(content("google", "fr")).toContain("Before update");
    expect(state.snapshots.filter((snapshot) => snapshot.isCurrent)).toHaveLength(4);
  });
});