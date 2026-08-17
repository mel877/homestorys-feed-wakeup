/**
 * Integration tests for the Meta feed publish gate in
 * src/exporters/meta/generator.ts → publishFeed().
 *
 * All external I/O is mocked (GCS, DB, Shopify, config).
 * The generator logic itself runs end-to-end.
 *
 * Key invariant: feed_snapshots.is_current=true must appear ONLY when the
 * atomic publish gate passes. Three gate scenarios are covered:
 *
 *   A. Happy-path (first publish, schema valid) → published, DB row inserted
 *   B. Schema validation errors → atomicPublish never called, no DB insert
 *   C. Item-count drop exceeds threshold → atomicPublish returns false, no DB insert
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
process.env["CONFIG_DIR"] = resolve(__dir, "../../../config");
process.env["META_DRY_RUN"] = "false"; // disable dry-run so the gate is exercised

// These imports get the mocked @workspace/db values; imported early so the
// type-safe mocks are available before vi.mock() hoisting resolves.
// eslint-disable-next-line import/first
import {
  db as _db,
  productsTable as _productsTable,
  variantsTable as _variantsTable,
  marketVariantsTable as _marketVariantsTable,
} from "@workspace/db";

// ── Hoisted mock state ────────────────────────────────────────────────────────

const {
  mockAtomicPublish,
  mockUploadFeedFile,
  mockUploadManifest,
  mockDownloadManifest,
  mockValidateMetaFeed,
  mockProcessAllCanonicals,
  mockDbInsert,
  mockDbUpdate,
  mockBuildCanonical,
} = vi.hoisted(() => {
  const mockDbInsertValues = vi.fn().mockResolvedValue([]);
  const mockDbInsert = vi.fn().mockReturnValue({ values: mockDbInsertValues });

  const mockDbUpdateSet = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([]),
  });
  const mockDbUpdate = vi.fn().mockReturnValue({ set: mockDbUpdateSet });

  return {
    mockAtomicPublish: vi.fn(),
    mockUploadFeedFile: vi.fn().mockResolvedValue("sha256-abc"),
    mockUploadManifest: vi.fn().mockResolvedValue(undefined),
    mockDownloadManifest: vi.fn().mockResolvedValue(null), // null = no prior snapshot
    mockValidateMetaFeed: vi.fn(),
    mockProcessAllCanonicals: vi.fn(), // kept for backward compat; generator no longer calls it
    mockDbInsert,
    mockDbUpdate,
    // buildCanonical returns null → all variants excluded → 0 rows per file,
    // but all 7 publishFeed calls still happen so the gate logic is exercised.
    mockBuildCanonical: vi.fn().mockReturnValue(null),
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../src/lib/storage", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/storage")>();
  return {
    ...orig, // keep pure helpers (metaFeedPath, versionedPath, formatVersionTs)
    uploadFeedFile: mockUploadFeedFile,
    uploadManifest: mockUploadManifest,
    downloadManifest: mockDownloadManifest,
    atomicPublish: mockAtomicPublish,
  };
});

vi.mock("../src/validation/feed-validator", () => ({
  validateMetaFeed: mockValidateMetaFeed,
}));

// The generator no longer uses processAllCanonicals, but keep the mock so any
// lingering import doesn't crash the test runner.
vi.mock("../src/exporters/canonical-reader", () => ({
  processAllCanonicals: mockProcessAllCanonicals,
}));

// buildCanonical returns null → all variants are treated as excluded → 0 rows
// per feed file, but all 7 publishFeed calls still happen (one per file) so the
// gate and snapshot logic is fully exercised.
vi.mock("../src/canonical/builder", () => ({
  buildCanonical: mockBuildCanonical,
}));

vi.mock("../src/shopify/checksums", () => ({
  computeChecksum: vi.fn().mockReturnValue("checksum-abc"),
}));

vi.mock("../src/lib/alerting", () => ({
  resolveAlertWebhookUrl: vi.fn().mockReturnValue(null),
  sendFeedBlockAlert: vi.fn().mockResolvedValue(undefined),
}));

// Provide all table exports that runMetaExport's bulk loader imports.
// Each table is a distinct object so the smart from() implementation can
// return the right rows per table.
vi.mock("@workspace/db", () => {
  const productsTableStub = { $inferInsert: null, status: "status", id: "id" };
  const variantsTableStub = { $inferInsert: null, productId: "productId", id: "id" };
  const marketVariantsTableStub = { $inferInsert: null, variantId: "variantId", marketCode: "mc" };
  const productTranslationsTableStub = { productId: "productId" };
  const imagesTableStub = { productId: "productId" };
  const inventoryLevelsTableStub = { variantId: "variantId" };
  const recommendationsTableStub = { productId: "productId" };
  const feedItemsTableStub = {
    $inferInsert: null,
    variantId: "variantId",
    marketCode: "marketCode",
    language: "language",
    channel: "channel",
  };
  const feedSnapshotsTableStub = {
    $inferInsert: null,
    channel: "channel",
    storagePath: "storagePath",
    isCurrent: "isCurrent",
  };

  // Minimal DB rows so the generator passes the early-exit guard (products.length > 0)
  // and enters the market loop. buildCanonical is mocked to return null so all
  // variants end up excluded and 0 rows accumulate — but all 7 publishFeed calls
  // still fire (one per file) so gate + snapshot logic is exercised.
  const PRODUCT = { id: "p1", status: "active", title: "Test" };
  const VARIANT = { id: "v1", productId: "p1", price: "99.99" };
  const MVS = ["BE_FR", "BE_DE", "FR", "DE", "AT"].map((mc, i) => ({
    id: `mv${i}`,
    variantId: "v1",
    marketCode: mc,
    isEligible: true,
  }));

  const dataByTable = new Map<object, unknown[]>([
    [productsTableStub, [PRODUCT]],
    [variantsTableStub, [VARIANT]],
    [marketVariantsTableStub, MVS],
  ]);

  return {
    db: {
      insert: mockDbInsert,
      update: mockDbUpdate,
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation((table: object) => ({
          where: vi.fn().mockResolvedValue(dataByTable.get(table) ?? []),
        })),
      }),
    },
    productsTable: productsTableStub,
    variantsTable: variantsTableStub,
    marketVariantsTable: marketVariantsTableStub,
    productTranslationsTable: productTranslationsTableStub,
    imagesTable: imagesTableStub,
    inventoryLevelsTable: inventoryLevelsTableStub,
    recommendationsTable: recommendationsTableStub,
    feedItemsTable: feedItemsTableStub,
    feedSnapshotsTable: feedSnapshotsTableStub,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn().mockReturnValue({}),
  and: vi.fn().mockReturnValue({}),
  desc: vi.fn().mockReturnValue({}),
  inArray: vi.fn().mockReturnValue({}),
  sql: vi.fn().mockReturnValue({}),
}));

// ── Shared canonical fixture ──────────────────────────────────────────────────

/**
 * makeCanonical: a minimal canonical product that mapToMeta can map.
 */
function makeCanonical(id = "product-1") {
  return {
    id,
    shopifyId: `gid://shopify/Product/${id}`,
    handle: `handle-${id}`,
    title: `Product ${id}`,
    titleFr: `Produit ${id}`,
    titleDe: `Produkt ${id}`,
    descriptionFr: "Description FR",
    descriptionDe: "Beschreibung DE",
    vendor: "TestBrand",
    productType: "Shoes",
    canonicalCategory: "Apparel & Accessories",
    googleProductCategory: "187",
    ageGroup: "adult",
    gender: "unisex",
    material: null,
    pattern: null,
    brand: "TestBrand",
    condition: "new" as const,
    isOutlet: false,
    variants: [
      {
        id: `variant-${id}`,
        shopifyVariantId: `gid://shopify/ProductVariant/v-${id}`,
        sku: `SKU-${id}`,
        barcode: "1234567890123",
        size: "M",
        color: "Blue",
        colorCode: null,
        weight: 500,
        weightUnit: "g",
        markets: {
          BE_FR: {
            available: true,
            price: 99.99,
            compareAtPrice: null,
            currencyCode: "EUR",
            inventoryQuantity: 10,
            sellWhenOutOfStock: false,
            inventoryPolicy: "deny" as const,
          },
          BE_DE: {
            available: true,
            price: 99.99,
            compareAtPrice: null,
            currencyCode: "EUR",
            inventoryQuantity: 5,
            sellWhenOutOfStock: false,
            inventoryPolicy: "deny" as const,
          },
          FR: {
            available: true,
            price: 99.99,
            compareAtPrice: null,
            currencyCode: "EUR",
            inventoryQuantity: 8,
            sellWhenOutOfStock: false,
            inventoryPolicy: "deny" as const,
          },
          DE: {
            available: true,
            price: 99.99,
            compareAtPrice: null,
            currencyCode: "EUR",
            inventoryQuantity: 6,
            sellWhenOutOfStock: false,
            inventoryPolicy: "deny" as const,
          },
          AT: {
            available: true,
            price: 99.99,
            compareAtPrice: null,
            currencyCode: "EUR",
            inventoryQuantity: 4,
            sellWhenOutOfStock: false,
            inventoryPolicy: "deny" as const,
          },
        },
        images: [{ src: `https://cdn.shopify.com/img-${id}.jpg`, position: 1 }],
        metafields: {},
        qualityScore: 85,
      },
    ],
    images: [{ src: `https://cdn.shopify.com/img-${id}.jpg`, position: 1 }],
    tags: [],
    status: "active" as const,
    updatedAt: new Date().toISOString(),
    metafields: {},
  };
}

/**
 * Set up processAllCanonicals to call the visitor callback with `count` canonicals,
 * then resolve with eligibility stats.
 */
function setupCanonicals(count = 3) {
  mockProcessAllCanonicals.mockImplementation(
    async (
      _config: unknown,
      _opts: unknown,
      visitor: (c: ReturnType<typeof makeCanonical>) => void,
    ) => {
      for (let i = 0; i < count; i++) {
        visitor(makeCanonical(`p${i}`));
      }
      return { eligible: count, ineligible: 0, excluded: 0 };
    },
  );
}

// ── Scenario helpers ──────────────────────────────────────────────────────────

/** Gate passes: atomicPublish returns true (new file is copied to current) */
function gatePassesAlways() {
  mockAtomicPublish.mockResolvedValue(true);
}

/** Gate blocks: atomicPublish returns false (drop exceeded) */
function gateBlockedByDrop() {
  mockAtomicPublish.mockResolvedValue(false);
}

/** Schema validation succeeds */
function schemaValid() {
  mockValidateMetaFeed.mockResolvedValue({
    valid: true,
    errorCount: 0,
    errors: [],
    rowCount: 3,
    file: "",
    schema: "meta-base",
  });
}

/** Schema validation fails */
function schemaInvalid() {
  mockValidateMetaFeed.mockResolvedValue({
    valid: false,
    errorCount: 2,
    errors: [
      { row: 1, field: "id", message: "required", value: "" },
      { row: 2, field: "availability", message: "invalid enum", value: "maybe" },
    ],
    rowCount: 3,
    file: "",
    schema: "meta-base",
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Minimal DB rows reused across tests to keep db.select returning real data.
// These are defined at module scope so they survive vi.clearAllMocks().
const _PRODUCT = { id: "p1", status: "active", title: "Test" };
const _VARIANT = { id: "v1", productId: "p1", price: "99.99" };
const _MVS = ["BE_FR", "BE_DE", "FR", "DE", "AT"].map((mc, i) => ({
  id: `mv${i}`,
  variantId: "v1",
  marketCode: mc,
  isEligible: true,
}));

/**
 * Re-apply the db.select mock implementation.
 *
 * vi.clearAllMocks() also clears vi.fn() instances created inside the
 * vi.mock() factory (they are registered in the same mock registry), which
 * resets their mockReturnValue and mockImplementation.  We call this helper
 * in beforeEach so every test starts with a working db.select that returns
 * the minimal fixture rows needed to pass the generator's early-exit guard.
 */
function resetDbSelectMock() {
  const dataByTable = new Map<object, unknown[]>([
    [_productsTable as object, [_PRODUCT]],
    [_variantsTable as object, [_VARIANT]],
    [_marketVariantsTable as object, _MVS],
  ]);
  (_db.select as Mock).mockReturnValue({
    from: vi.fn().mockImplementation((table: object) => ({
      where: vi.fn().mockResolvedValue(dataByTable.get(table) ?? []),
    })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Storage / manifest mocks
  mockUploadFeedFile.mockResolvedValue("sha256-abc");
  mockUploadManifest.mockResolvedValue(undefined);
  mockDownloadManifest.mockResolvedValue(null); // no prior snapshot = first publish
  // Canonical builder mock (returns null → 0 rows per file, but publishFeed still fires)
  mockBuildCanonical.mockReturnValue(null);
  // db.insert / db.update default chains
  mockDbInsert.mockReturnValue({ values: vi.fn().mockResolvedValue([]) });
  mockDbUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
  });
  // db.select MUST be re-initialised after clearAllMocks (see resetDbSelectMock docstring)
  resetDbSelectMock();
});

describe("Meta generator gate — happy path (first publish, schema valid)", () => {
  it("calls atomicPublish for each feed file", async () => {
    setupCanonicals(3);
    schemaValid();
    gatePassesAlways();

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    await runMetaExport({});

    // 7 feed files: base + language-fr + language-de + 4 country files
    expect(mockAtomicPublish).toHaveBeenCalledTimes(7);
  });

  it("inserts a feed_snapshots row with isCurrent=true for each published file", async () => {
    setupCanonicals(3);
    schemaValid();
    gatePassesAlways();

    const insertedRows: Record<string, unknown>[] = [];
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockImplementation((row: Record<string, unknown>) => {
        insertedRows.push(row);
        return Promise.resolve([]);
      }),
    });

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    await runMetaExport({});

    // Every inserted snapshot row must have isCurrent: true
    expect(insertedRows.length).toBeGreaterThan(0);
    for (const row of insertedRows) {
      expect(row["isCurrent"]).toBe(true);
    }
  });

  it("marks previous snapshots as isCurrent=false before inserting new row", async () => {
    setupCanonicals(3);
    schemaValid();
    gatePassesAlways();

    const callOrder: string[] = [];
    mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          callOrder.push("update");
          return Promise.resolve([]);
        }),
      }),
    });
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        callOrder.push("insert");
        return Promise.resolve([]);
      }),
    });

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    await runMetaExport({});

    // For each published file: update(isCurrent=false) must come before insert(isCurrent=true)
    for (let i = 0; i < callOrder.length - 1; i += 2) {
      expect(callOrder[i]).toBe("update");
      expect(callOrder[i + 1]).toBe("insert");
    }
  });

  it("returns published=true for all 7 files in a full run", async () => {
    setupCanonicals(3);
    schemaValid();
    gatePassesAlways();

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    const result = await runMetaExport({});

    const keys = Object.keys(result.files) as (keyof typeof result.files)[];
    for (const key of keys) {
      expect(result.files[key].published, `${key} should be published`).toBe(true);
    }
  });
});

describe("Meta generator gate — schema errors block publish", () => {
  it("does NOT call atomicPublish when schema validation fails", async () => {
    setupCanonicals(3);
    schemaInvalid();

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    await runMetaExport({});

    expect(mockAtomicPublish).not.toHaveBeenCalled();
  });

  it("does NOT insert a feed_snapshots row when schema validation fails", async () => {
    setupCanonicals(3);
    schemaInvalid();

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    await runMetaExport({});

    // db.insert().values() should never have been called with isCurrent=true
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it("returns published=false for all files when schema is invalid", async () => {
    setupCanonicals(3);
    schemaInvalid();

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    const result = await runMetaExport({});

    const keys = Object.keys(result.files) as (keyof typeof result.files)[];
    for (const key of keys) {
      expect(result.files[key].published, `${key} should NOT be published`).toBe(false);
    }
  });
});

describe("Meta generator gate — item-count drop blocks publish", () => {
  it("does NOT insert a feed_snapshots row when atomicPublish returns false", async () => {
    setupCanonicals(3);
    schemaValid();
    gateBlockedByDrop();

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    await runMetaExport({});

    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it("returns published=false for files that were blocked by the drop gate", async () => {
    setupCanonicals(3);
    schemaValid();
    gateBlockedByDrop();

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    const result = await runMetaExport({});

    const keys = Object.keys(result.files) as (keyof typeof result.files)[];
    for (const key of keys) {
      expect(result.files[key].published, `${key} should NOT be published`).toBe(false);
    }
  });

  it("uses the previous snapshot item count when one exists", async () => {
    setupCanonicals(3);
    schemaValid();

    // Simulate a prior snapshot with 1000 items → triggers the threshold check
    mockDownloadManifest.mockResolvedValue({
      version: "prev",
      generatedAt: new Date().toISOString(),
      itemCount: 1000,
      sha256: "prev-hash",
      sourceRunId: null,
      channel: "meta",
      language: null,
      marketCode: null,
    });
    gateBlockedByDrop();

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    await runMetaExport({});

    // atomicPublish was called with the previousItemCount from the manifest
    const call = mockAtomicPublish.mock.calls[0] as [Record<string, unknown>];
    expect(call[0]["previousItemCount"]).toBe(1000);
  });
});

describe("Meta generator gate — is_current=true only when gate passes", () => {
  it("gate pass → isCurrent=true row written; gate block → no row written", async () => {
    // First call: gate passes → row written
    setupCanonicals(2);
    schemaValid();
    gatePassesAlways();

    const insertedRows: Record<string, unknown>[] = [];
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockImplementation((row: Record<string, unknown>) => {
        insertedRows.push(row);
        return Promise.resolve([]);
      }),
    });

    const { runMetaExport } = await import("../src/exporters/meta/generator");
    await runMetaExport({});
    expect(insertedRows.length).toBeGreaterThan(0);
    expect(insertedRows.every((r) => r["isCurrent"] === true)).toBe(true);

    // Second call: gate blocked → no new rows
    vi.clearAllMocks();
    insertedRows.length = 0;
    setupCanonicals(2);
    schemaValid();
    gateBlockedByDrop();
    mockUploadFeedFile.mockResolvedValue("sha256-abc");
    mockUploadManifest.mockResolvedValue(undefined);
    mockDownloadManifest.mockResolvedValue(null);
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockImplementation((row: Record<string, unknown>) => {
        insertedRows.push(row);
        return Promise.resolve([]);
      }),
    });

    await runMetaExport({});
    expect(insertedRows.length).toBe(0);
  });
});
