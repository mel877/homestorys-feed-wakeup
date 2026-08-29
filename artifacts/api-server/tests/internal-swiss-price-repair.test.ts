import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const {
  mockTryAcquireLock,
  mockReleaseLock,
  mockTrackerStart,
  mockTrackerComplete,
  mockTrackerFail,
  mockRunSwissPriceRepair,
  mockDbUpdate,
  mockDbSelect,
  mockMarketPriceLeaseRelease,
  mockTryAcquireMarketPriceWriteLock,
} = vi.hoisted(() => ({
  mockTryAcquireLock: vi.fn().mockResolvedValue({ acquired: true }),
  mockReleaseLock: vi.fn(),
  mockTrackerStart: vi.fn().mockResolvedValue("00000000-0000-4000-8000-000000000001"),
  mockTrackerComplete: vi.fn().mockResolvedValue({}),
  mockTrackerFail: vi.fn().mockResolvedValue(undefined),
  mockRunSwissPriceRepair: vi.fn().mockResolvedValue({
    dryRun: true,
    targetedVariants: 1,
    queriedAtShopify: 1,
    correctedVariants: 0,
    shopifyApiCalls: 1,
    remainingEligibleEur: 0,
    remainingTotalEur: 0,
    remainingExcludedEur: 0,
    eligibleCurrencyDistribution: {
      CH_DE: { CHF: 1, EUR: 0, other: 0 },
      CH_FR: { CHF: 1, EUR: 0, other: 0 },
    },
    validPromotions: { uniqueVariants: 0, byMarket: { CH_DE: 0, CH_FR: 0 } },
    contextualPricesMatch: true,
    noCurrencyConversionPerformed: true,
    validators: {
      google: { passed: true, rowsChecked: 1, errors: [] },
      meta: { passed: true, rowsChecked: 1, errors: [] },
    },
  }),
  mockDbUpdate: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  }),
  mockDbSelect: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{
          id: "00000000-0000-4000-8000-000000000001",
          runType: "swiss-price-repair",
          metadata: { reportStatus: "completed" },
        }]),
      }),
    }),
  }),
  mockMarketPriceLeaseRelease: vi.fn().mockResolvedValue(undefined),
  mockTryAcquireMarketPriceWriteLock: vi.fn(),
}));

mockTryAcquireMarketPriceWriteLock.mockResolvedValue({
  release: mockMarketPriceLeaseRelease,
});

vi.mock("@workspace/db", () => ({
  db: {
    update: mockDbUpdate,
    select: mockDbSelect,
  },
  syncRunsTable: { id: "id", metadata: "metadata" },
}));

vi.mock("drizzle-orm", () => ({
  desc: vi.fn(),
  eq: vi.fn((...parts: unknown[]) => parts),
  sql: vi.fn((...parts: unknown[]) => parts),
}));

vi.mock("../src/jobs/scheduler", () => ({
  tryAcquireLock: mockTryAcquireLock,
  releaseLock: mockReleaseLock,
}));

vi.mock("../src/shopify/sync-run-tracker", () => ({
  SyncRunTracker: class {
    start = mockTrackerStart;
    complete = mockTrackerComplete;
    fail = mockTrackerFail;
  },
}));

vi.mock("../src/shopify/swiss-price-repair", () => ({
  runSwissPriceRepair: mockRunSwissPriceRepair,
  SwissPriceValidationError: class SwissPriceValidationError extends Error {
    constructor(public readonly issues: unknown[]) {
      super("Swiss contextual price validation failed");
    }
  },
}));

vi.mock("../src/config", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

vi.mock("../src/shopify/client", () => ({
  getShopifyClient: vi.fn().mockReturnValue({}),
}));

vi.mock("../src/shopify/market-price-write-lock", () => ({
  tryAcquireMarketPriceWriteLock: mockTryAcquireMarketPriceWriteLock,
}));

vi.mock("../src/shopify/index", () => ({
  runFullSync: vi.fn(),
  runInventorySync: vi.fn(),
  runPriceSync: vi.fn(),
  syncProduct: vi.fn(),
}));

let app: Express;

beforeAll(async () => {
  process.env["APP_ENV"] = "production";
  process.env["NODE_ENV"] = "test";
  process.env["INTERNAL_API_SECRET"] = "test-secret";

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    next();
  });

  const { default: router } = await import("../src/routes/internal");
  app.use("/api/internal", router);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockTryAcquireLock.mockResolvedValue({ acquired: true });
  mockTryAcquireMarketPriceWriteLock.mockResolvedValue({
    release: mockMarketPriceLeaseRelease,
  });
  mockTrackerStart.mockResolvedValue("00000000-0000-4000-8000-000000000001");
  mockRunSwissPriceRepair.mockResolvedValue({
    dryRun: true,
    targetedVariants: 1,
    queriedAtShopify: 1,
    correctedVariants: 0,
    shopifyApiCalls: 1,
    remainingEligibleEur: 0,
    remainingTotalEur: 0,
    remainingExcludedEur: 0,
    eligibleCurrencyDistribution: {
      CH_DE: { CHF: 1, EUR: 0, other: 0 },
      CH_FR: { CHF: 1, EUR: 0, other: 0 },
    },
    validPromotions: { uniqueVariants: 0, byMarket: { CH_DE: 0, CH_FR: 0 } },
    contextualPricesMatch: true,
    noCurrencyConversionPerformed: true,
    validators: {
      google: { passed: true, rowsChecked: 1, errors: [] },
      meta: { passed: true, rowsChecked: 1, errors: [] },
    },
  });
});

const auth = { Authorization: "Bearer test-secret" };

describe("POST /api/internal/repair/swiss-prices", () => {
  it("requires the internal production authentication", async () => {
    const response = await request(app)
      .post("/api/internal/repair/swiss-prices")
      .send({});

    expect(response.status).toBe(401);
    expect(mockTryAcquireLock).not.toHaveBeenCalled();
    expect(mockTrackerStart).not.toHaveBeenCalled();
    expect(mockTryAcquireMarketPriceWriteLock).not.toHaveBeenCalled();
  });

  it("cannot be triggered outside the production environment", async () => {
    process.env["APP_ENV"] = "development";
    try {
      const response = await request(app)
        .post("/api/internal/repair/swiss-prices")
        .set(auth)
        .send({});

      expect(response.status).toBe(403);
      expect(mockTryAcquireLock).not.toHaveBeenCalled();
      expect(mockTrackerStart).not.toHaveBeenCalled();
      expect(mockRunSwissPriceRepair).not.toHaveBeenCalled();
      expect(mockTryAcquireMarketPriceWriteLock).not.toHaveBeenCalled();
    } finally {
      process.env["APP_ENV"] = "production";
    }
  });

  it("fails closed when APP_ENV is absent", async () => {
    delete process.env["APP_ENV"];
    try {
      const response = await request(app)
        .post("/api/internal/repair/swiss-prices")
        .set(auth)
        .send({});

      expect(response.status).toBe(403);
      expect(mockTryAcquireLock).not.toHaveBeenCalled();
      expect(mockTryAcquireMarketPriceWriteLock).not.toHaveBeenCalled();
      expect(mockTrackerStart).not.toHaveBeenCalled();
    } finally {
      process.env["APP_ENV"] = "production";
    }
  });

  it("rejects apply requests without explicit confirmation before creating a run", async () => {
    const response = await request(app)
      .post("/api/internal/repair/swiss-prices")
      .set(auth)
      .send({ apply: true });

    expect(response.status).toBe(400);
    expect(mockTryAcquireLock).not.toHaveBeenCalled();
    expect(mockTrackerStart).not.toHaveBeenCalled();
    expect(mockRunSwissPriceRepair).not.toHaveBeenCalled();
  });

  it.each(["full", "export"])(
    "rejects a %s payload instead of dispatching another operation",
    async (runType) => {
      const response = await request(app)
        .post("/api/internal/repair/swiss-prices")
        .set(auth)
        .send({ runType });

      expect(response.status).toBe(400);
      expect(mockTryAcquireLock).not.toHaveBeenCalled();
      expect(mockTrackerStart).not.toHaveBeenCalled();
      expect(mockRunSwissPriceRepair).not.toHaveBeenCalled();
    },
  );

  it("starts a read-only preview by default and persists its complete report", async () => {
    const response = await request(app)
      .post("/api/internal/repair/swiss-prices")
      .set(auth)
      .send({});

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      operation: "repair:swiss-prices",
      mode: "preview",
      runId: "00000000-0000-4000-8000-000000000001",
    });

    await vi.waitFor(() => {
      expect(mockRunSwissPriceRepair).toHaveBeenCalledWith({
        config: {},
        client: {},
        apply: false,
      });
    });
    expect(mockTrackerStart).toHaveBeenCalledWith(
      "swiss-price-repair",
      expect.objectContaining({
        operation: "repair:swiss-prices",
        mode: "preview",
        authorization: "read-only",
      }),
    );
    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockTrackerComplete).toHaveBeenCalled();
    expect(mockMarketPriceLeaseRelease).toHaveBeenCalled();
  });

  it("allows writes only with the exact explicit confirmation phrase", async () => {
    const response = await request(app)
      .post("/api/internal/repair/swiss-prices")
      .set(auth)
      .send({
        apply: true,
        confirmation: "APPLY_SWISS_PRICE_REPAIR",
      });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(mockRunSwissPriceRepair).toHaveBeenCalledWith({
        config: {},
        client: {},
        apply: true,
      });
    });
    expect(mockTrackerStart).toHaveBeenCalledWith(
      "swiss-price-repair",
      expect.objectContaining({
        mode: "apply",
        authorization: "explicit-confirmation",
      }),
    );
  });

  it("persists complete validation issues when Shopify validation aborts the write", async () => {
    const { SwissPriceValidationError } = await import("../src/shopify/swiss-price-repair");
    const error = new SwissPriceValidationError([
      { variantGid: "gid://shopify/ProductVariant/1", code: "NON_CHF_PRICE" },
    ]);
    mockRunSwissPriceRepair.mockRejectedValueOnce(error);

    const response = await request(app)
      .post("/api/internal/repair/swiss-prices")
      .set(auth)
      .send({
        apply: true,
        confirmation: "APPLY_SWISS_PRICE_REPAIR",
      });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(mockTrackerFail).toHaveBeenCalledWith(error);
    });
    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockMarketPriceLeaseRelease).toHaveBeenCalled();
  });

  it("retrieves the exact persisted run and report by ID", async () => {
    const response = await request(app)
      .get("/api/internal/runs/00000000-0000-4000-8000-000000000001")
      .set(auth);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      run: {
        id: "00000000-0000-4000-8000-000000000001",
        runType: "swiss-price-repair",
        metadata: { reportStatus: "completed" },
      },
    });
  });
});