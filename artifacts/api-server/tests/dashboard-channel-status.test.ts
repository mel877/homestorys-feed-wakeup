import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const { mockData, mockSelect } = vi.hoisted(() => {
  const data = {
    feedSnapshots: [] as Row[],
    feedItems: [] as Row[],
  };

  function makeQuery(rows: Row[]) {
    let currentRows = [...rows];
    const query = {
      from(table: { tableName: string }) {
        currentRows = [
          ...(table.tableName === "feedSnapshots" ? data.feedSnapshots : data.feedItems),
        ];
        return query;
      },
      where(predicate: Predicate) {
        currentRows = currentRows.filter(predicate);
        return query;
      },
      groupBy() {
        return query;
      },
      orderBy() {
        return query;
      },
      limit(count: number) {
        currentRows = currentRows.slice(0, count);
        return query;
      },
      then<TResult1 = Row[], TResult2 = never>(
        onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(currentRows).then(onfulfilled, onrejected);
      },
    };
    return query;
  }

  return {
    mockData: data,
    mockSelect: vi.fn(() => makeQuery([])),
  };
});

vi.mock("../src/routes/dashboard/auth", () => ({
  requireDashboardAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: mockSelect,
  },
  feedSnapshotsTable: {
    tableName: "feedSnapshots",
    channel: "channel",
    language: "language",
    marketCode: "marketCode",
    itemCount: "itemCount",
    generatedAt: "generatedAt",
    isCurrent: "isCurrent",
  },
  feedItemsTable: {
    tableName: "feedItems",
    channel: "channel",
    marketCode: "marketCode",
    isEligible: "isEligible",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown): Predicate => (row) => row[column] === value,
  and: (...predicates: Predicate[]): Predicate => (row) => predicates.every((predicate) => predicate(row)),
  inArray: (column: string, values: unknown[]): Predicate => (row) => values.includes(row[column]),
  desc: (column: string) => column,
  sql: vi.fn(),
}));

async function buildApp(): Promise<Express> {
  const app = express();
  const [{ default: googleRouter }, { default: metaRouter }] = await Promise.all([
    import("../src/routes/dashboard/google"),
    import("../src/routes/dashboard/meta"),
  ]);
  app.use("/api", googleRouter);
  app.use("/api", metaRouter);
  return app;
}

let app: Express;

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockData.feedSnapshots = [];
  mockData.feedItems = [];
});

describe("GET /api/dashboard/google/status", () => {
  it("uses current snapshot counts for the published feed summary", async () => {
    mockData.feedSnapshots = [
      {
        channel: "google",
        language: "de",
        marketCode: "CH_DE",
        itemCount: 21_540,
        generatedAt: new Date("2026-08-30T09:16:34.706Z"),
        isCurrent: true,
        sha256: "current-google-sha",
      },
      {
        channel: "google",
        language: "de",
        marketCode: "CH_DE",
        itemCount: 21_565,
        generatedAt: new Date("2026-08-29T09:16:34.706Z"),
        isCurrent: false,
        sha256: "historical-google-sha",
      },
    ];
    mockData.feedItems = Array.from({ length: 3 }, () => ({
      channel: "google",
      marketCode: "CH_DE",
      isEligible: true,
    }));

    const response = await request(app).get("/api/dashboard/google/status");

    expect(response.status).toBe(200);
    expect(response.body.snapshots).toEqual([
      expect.objectContaining({
        marketCode: "CH_DE",
        itemCount: 21_540,
        sha256: "current-google-sha",
      }),
    ]);
    expect(response.body.byMarket).toEqual([]);
  });
});

describe("GET /api/dashboard/meta/status", () => {
  it("returns only current durable Meta snapshot identities", async () => {
    mockData.feedSnapshots = [
      {
        channel: "meta",
        language: "",
        marketCode: "BASE",
        itemCount: 171_972,
        generatedAt: new Date("2026-08-30T10:31:45.998Z"),
        isCurrent: true,
      },
      {
        channel: "meta",
        language: "fr",
        marketCode: "META_LANGUAGE_FR",
        itemCount: 64_504,
        generatedAt: new Date("2026-08-30T11:02:50.678Z"),
        isCurrent: true,
      },
      {
        channel: "meta",
        language: "fr",
        marketCode: "LANG_FR",
        itemCount: 81_141,
        generatedAt: new Date("2026-08-21T02:33:47.499Z"),
        isCurrent: true,
      },
      {
        channel: "meta",
        language: "",
        marketCode: "CH",
        itemCount: 43_105,
        generatedAt: new Date("2026-08-29T10:31:03.334Z"),
        isCurrent: false,
      },
    ];

    const response = await request(app).get("/api/dashboard/meta/status");

    expect(response.status).toBe(200);
    expect(response.body.feeds.map((feed: Row) => feed.marketCode)).toEqual([
      "BASE",
      "META_LANGUAGE_FR",
    ]);
    expect(response.body.lastPushAt).toBe("2026-08-30T11:02:50.678Z");
  });
});

describe("Meta dashboard public URLs", () => {
  it("maps durable language identities to language feed routes", async () => {
    const source = await readFile(
      resolve(process.cwd(), "../dashboard/src/pages/meta.tsx"),
      "utf8",
    );

    expect(source).toContain(
      'marketCode === "META_LANGUAGE_FR"',
    );
    expect(source).toContain(
      'return "/api/feeds/meta/lang/fr.csv"',
    );
    expect(source).toContain(
      'marketCode === "META_LANGUAGE_DE"',
    );
    expect(source).toContain(
      'return "/api/feeds/meta/lang/de.csv"',
    );
    expect(source).toContain(
      'marketCode === "BASE"',
    );
    expect(source).toContain(
      'return "/api/feeds/meta/base.csv"',
    );
  });
});