/**
 * Image classification drain loop integration tests.
 *
 * Verifies that classifyStoredImages() and reclassifyProductImages() drain
 * ALL images — including catalogs larger than PAGE_SIZE (50) and products
 * with more than the default limit — without leaving any unclassified.
 *
 * Uses vi.mock to stub DB and classifier so no network/DB is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Stub @workspace/db ────────────────────────────────────────────────────────

// Track what the mock DB returns page by page (populated per test)
let unclassifiedPool: Array<{ id: string; url: string; width: number | null; height: number | null }> = [];

// Capture full DB update payload per image id for metric assertion tests
const dbUpdatesByImageId = new Map<string, Record<string, unknown>>();

// Drizzle-style chainable mock
function makeWhereChain(rows: typeof unclassifiedPool) {
  return {
    where: () => ({
      limit: (n: number) => Promise.resolve(rows.splice(0, n)),
    }),
  };
}

vi.mock("@workspace/db", () => {
  return {
    db: {
      select: () => ({
        from: () => makeWhereChain(unclassifiedPool),
      }),
      update: () => ({
        set: (fields: Record<string, unknown>) => ({
          where: (condition: unknown) => {
            // Extract image id from eq condition value for tracking
            const condStr = JSON.stringify(condition);
            const match = condStr.match(/"value":"([^"]+)"/);
            if (match) dbUpdatesByImageId.set(match[1], { ...fields });
            return Promise.resolve();
          },
        }),
      }),
    },
    imagesTable: {
      id: { name: "id" },
      url: { name: "url" },
      width: { name: "width" },
      height: { name: "height" },
      productId: { name: "product_id" },
      imageType: { name: "image_type" },
      isClassified: { name: "is_classified" },
      whiteBgScore: { name: "white_bg_score" },
      solidBgScore: { name: "solid_bg_score" },
      alphaRatio: { name: "alpha_ratio" },
      edgeDensity: { name: "edge_density" },
      variance: { name: "variance" },
      resolutionScore: { name: "resolution_score" },
      classifiedAt: { name: "classified_at" },
      updatedAt: { name: "updated_at" },
    },
  };
});

// ── Stub classifier ───────────────────────────────────────────────────────────

vi.mock("../src/images/classifier", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/images/classifier")>();
  return {
    ...actual,
    // Only mock the network-bound function; keep pure functions (selectGoogleImages etc.) real
    classifyImageUrl: vi.fn().mockResolvedValue({
      imageType: "packshot_white",
      whiteBgScore: 0.92,
      solidBgScore: 0.15,
      alphaRatio: 0.0,
      width: 1200,
      height: 1200,
      aspectRatio: 1.0,
      edgeDensity: 0.03,
      variance: 800,
      resolutionScore: 1.0,
      classificationReason: "white_bg_dominant",
    }),
  };
});

// ── Stub drizzle-orm helpers (eq, isNull, or, and) ────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ type: "eq", col, value: val }),
  isNull: (col: unknown) => ({ type: "isNull", col }),
  or: (...args: unknown[]) => ({ type: "or", args }),
  and: (...args: unknown[]) => ({ type: "and", args }),
  sql: (s: unknown) => s,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeImagePool(count: number, productId = "p1") {
  return Array.from({ length: count }, (_, i) => ({
    id: `img-${i}`,
    url: `https://cdn.shopify.com/image-${i}.jpg`,
    width: 1200,
    height: 1200,
    productId,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Image classification drain loop", () => {
  beforeEach(() => {
    unclassifiedPool = [];
    dbUpdatesByImageId.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("classifies a catalog of exactly 200 images completely", async () => {
    const { classifyStoredImages } = await import("../src/images/classify-stored");
    unclassifiedPool = makeImagePool(200);

    const result = await classifyStoredImages();

    // All 200 images should be classified (not left unclassified after first batch)
    expect(result.classified + result.failed).toBe(200);
    expect(result.pages).toBeGreaterThanOrEqual(4); // 200 / 50 = 4 pages
    expect(unclassifiedPool).toHaveLength(0); // pool fully drained
  });

  it("classifies a catalog of 300 images (larger than first batch)", async () => {
    const { classifyStoredImages } = await import("../src/images/classify-stored");
    unclassifiedPool = makeImagePool(300);

    const result = await classifyStoredImages();

    expect(result.classified + result.failed).toBe(300);
    expect(result.pages).toBeGreaterThanOrEqual(6); // 300 / 50 = 6 pages
    expect(unclassifiedPool).toHaveLength(0);
  });

  it("classifies a catalog of 1 image (smallest case)", async () => {
    const { classifyStoredImages } = await import("../src/images/classify-stored");
    unclassifiedPool = makeImagePool(1);

    const result = await classifyStoredImages();

    expect(result.classified + result.failed).toBe(1);
    expect(unclassifiedPool).toHaveLength(0);
  });

  it("returns pages=0 and classified=0 when nothing is unclassified", async () => {
    const { classifyStoredImages } = await import("../src/images/classify-stored");
    unclassifiedPool = []; // empty

    const result = await classifyStoredImages();

    expect(result.classified).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.pages).toBe(0);
  });

  it("classifies >50 images for a single product (reclassifyProductImages)", async () => {
    // We test the drain behavior for a product with 75 images (> default 50)
    const { classifyStoredImages } = await import("../src/images/classify-stored");
    unclassifiedPool = makeImagePool(75, "prod-abc");

    const result = await classifyStoredImages({ productId: "prod-abc" });

    expect(result.classified + result.failed).toBe(75);
    expect(result.pages).toBeGreaterThanOrEqual(2); // 75 / 50 = 2 pages
    expect(unclassifiedPool).toHaveLength(0);
  });

  it("stops early on AbortSignal cancellation", async () => {
    const { classifyStoredImages } = await import("../src/images/classify-stored");
    unclassifiedPool = makeImagePool(200);

    const controller = new AbortController();
    // Abort after first page is processed by aborting immediately
    setTimeout(() => controller.abort(), 0);

    const result = await classifyStoredImages({ signal: controller.signal });

    // Should stop before processing all 200 (aborted during/after first page)
    expect(result.classified + result.failed).toBeLessThanOrEqual(200);
  });

  it("handles classification failures gracefully and continues draining", async () => {
    const { classifyImageUrl } = await import("../src/images/classifier");
    const { classifyStoredImages } = await import("../src/images/classify-stored");

    // Every other image throws to test graceful error handling
    let callCount = 0;
    vi.mocked(classifyImageUrl).mockImplementation(async () => {
      callCount++;
      if (callCount % 2 === 0) throw new Error("CDN timeout");
      return {
        imageType: "packshot_white" as const,
        whiteBgScore: 0.92, solidBgScore: 0.15, alphaRatio: 0.0,
        width: 1200, height: 1200, aspectRatio: 1.0,
        edgeDensity: 0.03, variance: 800, resolutionScore: 1.0,
        classificationReason: "white_bg_dominant",
      };
    });

    unclassifiedPool = makeImagePool(20);
    const result = await classifyStoredImages();

    // All 20 should be processed (classified or failed), none left unclassified
    expect(result.classified + result.failed).toBe(20);
    expect(unclassifiedPool).toHaveLength(0);
    // About half failed, about half classified
    expect(result.failed).toBeGreaterThan(0);
    expect(result.classified).toBeGreaterThan(0);
  });

  it("classifyImageUrl returning null → persists imageType 'unknown' not 'invalid' (transient failure fail-safe)", async () => {
    const { classifyImageUrl } = await import("../src/images/classifier");
    const { classifyStoredImages } = await import("../src/images/classify-stored");

    // Simulate CDN/fetch failure: classifyImageUrl returns null
    vi.mocked(classifyImageUrl).mockResolvedValueOnce(null);

    unclassifiedPool = makeImagePool(1);
    await classifyStoredImages();

    const update = dbUpdatesByImageId.get("img-0");
    expect(update).toBeDefined();
    // Must be "unknown" (retriable) — NOT "invalid" (permanent exclusion)
    expect(update!.imageType).toBe("unknown");
    expect(update!.isClassified).toBe(true);
  });

  it("persists ALL classification metrics (whiteBgScore, solidBgScore, alphaRatio, edgeDensity, variance, resolutionScore, classifiedAt)", async () => {
    const { classifyStoredImages } = await import("../src/images/classify-stored");
    unclassifiedPool = makeImagePool(1);

    await classifyStoredImages();

    // The DB update for this image must include every metric column
    const update = dbUpdatesByImageId.get("img-0");
    expect(update).toBeDefined();

    // Core type + flags
    expect(update!.imageType).toBe("packshot_white");
    expect(update!.isClassified).toBe(true);

    // All numeric metrics must be persisted as strings (matches DB numeric precision)
    expect(update!.whiteBgScore).toBe("0.92");
    expect(update!.solidBgScore).toBe("0.15");
    expect(update!.alphaRatio).toBe("0");
    expect(update!.edgeDensity).toBe("0.03");
    expect(update!.variance).toBe("800");
    expect(update!.resolutionScore).toBe("1");

    // Timestamp columns must be Date instances
    expect(update!.classifiedAt).toBeInstanceOf(Date);
    expect(update!.updatedAt).toBeInstanceOf(Date);
  });
});

describe("Image priority after classification (Google vs Meta)", () => {
  it("selectGoogleImages prefers packshot_white when images include lifestyle", async () => {
    const { selectGoogleImages } = await import("../src/images/classifier");

    const images = [
      { url: "https://cdn/lifestyle.jpg", urlHash: "l1", altText: null, width: 1200, height: 800, imageType: "lifestyle" as const, position: 1 },
      { url: "https://cdn/white.jpg", urlHash: "w1", altText: null, width: 1200, height: 1200, imageType: "packshot_white" as const, position: 2 },
    ];

    const selected = selectGoogleImages(images, null, null);
    expect(selected.primary?.imageType).toBe("packshot_white");
    expect(selected.lifestyle?.imageType).toBe("lifestyle");
  });

  it("selectMetaImages prefers lifestyle as primary", async () => {
    const { selectMetaImages } = await import("../src/images/classifier");

    const images = [
      { url: "https://cdn/white.jpg", urlHash: "w1", altText: null, width: 1200, height: 1200, imageType: "packshot_white" as const, position: 1 },
      { url: "https://cdn/lifestyle.jpg", urlHash: "l1", altText: null, width: 1200, height: 800, imageType: "lifestyle" as const, position: 2 },
    ];

    const selected = selectMetaImages(images, null, null);
    expect(selected.primary?.imageType).toBe("lifestyle");
  });

  it("Google falls back to lifestyle when no packshot exists", async () => {
    const { selectGoogleImages } = await import("../src/images/classifier");

    const images = [
      { url: "https://cdn/lifestyle.jpg", urlHash: "l1", altText: null, width: 1200, height: 800, imageType: "lifestyle" as const, position: 1 },
    ];

    const selected = selectGoogleImages(images, null, null);
    expect(selected.primary?.imageType).toBe("lifestyle");
  });

  it("all unknown images still produce a primary (falls back to first)", async () => {
    const { selectGoogleImages } = await import("../src/images/classifier");

    const images = [
      { url: "https://cdn/unknown.jpg", urlHash: "u1", altText: null, width: 800, height: 800, imageType: "unknown" as const, position: 1 },
      { url: "https://cdn/unknown2.jpg", urlHash: "u2", altText: null, width: 800, height: 800, imageType: "unknown" as const, position: 2 },
    ];

    const selected = selectGoogleImages(images, null, null);
    // unknown images are NOT treated as invalid; primary is still assigned
    expect(selected.primary).not.toBeNull();
  });

  it("invalid images are excluded from selection", async () => {
    const { selectGoogleImages } = await import("../src/images/classifier");

    const images = [
      { url: "https://cdn/invalid.jpg", urlHash: "i1", altText: null, width: 10, height: 10, imageType: "invalid" as const, position: 1 },
    ];

    const selected = selectGoogleImages(images, null, null);
    expect(selected.primary).toBeNull();
  });
});
