import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import express, { type Express } from "express";
import request from "supertest";

// ── DB mock ────────────────────────────────────────────────────────────────────
// Stub db so tests run without a real Postgres connection.

const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockInsertOnConflict = vi.fn().mockReturnValue({
  returning: vi.fn().mockResolvedValue([{ id: "new-uuid" }]),
});
const mockInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({
    onConflictDoNothing: mockInsertOnConflict,
  }),
});

vi.mock("@workspace/db", () => ({
  db: {
    insert: mockInsert,
  },
  webhookEventsTable: { id: "id" },
  // drizzle sql tagged template — not needed for webhooks but imported in webhooks.ts
  sql: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHmac(secret: string, body: string | Buffer): string {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return createHmac("sha256", secret).update(buf).digest("base64");
}

async function buildTestApp(env: Record<string, string | undefined> = {}): Promise<Express> {
  // Apply env vars before importing the router (router reads process.env at call time)
  const app = express();

  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  // Mirror app.ts: raw body parser before json parser
  app.use("/api/webhooks", express.raw({ type: "*/*" }));
  app.use(express.json());

  // Minimal req.log shim
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, (...args: unknown[]) => void> }).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    next();
  });

  // Fresh import after env mutation
  vi.resetModules();
  const { default: webhooksRouter } = await import("../src/routes/webhooks");
  app.use("/api/webhooks", webhooksRouter);
  return app;
}

const SECRET = "test-webhook-secret-xyz";
const TOPIC = "products/update";
const WEBHOOK_ID = "wh-001";
const SHOP = "homestorys.myshopify.com";
const PAYLOAD = JSON.stringify({ id: 42, title: "Sofa" });

// Reset mock implementations before each test
beforeEach(() => {
  vi.clearAllMocks();

  // Default: successful insert (not a duplicate)
  const returning = vi.fn().mockResolvedValue([{ id: "new-uuid" }]);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  mockInsert.mockReturnValue({ values });
});

afterEach(() => {
  delete process.env["SHOPIFY_WEBHOOK_SECRET"];
  delete process.env["APP_ENV"];
  delete process.env["NODE_ENV"];
  vi.resetModules();
});

// ── HMAC validation ───────────────────────────────────────────────────────────

describe("POST /api/webhooks/shopify — HMAC validation", () => {
  it("accepts a request with a valid HMAC signature", async () => {
    const app = await buildTestApp({
      SHOPIFY_WEBHOOK_SECRET: SECRET,
      APP_ENV: "development",
    });
    const hmac = makeHmac(SECRET, PAYLOAD);

    const res = await request(app)
      .post("/api/webhooks/shopify")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", hmac)
      .set("X-Shopify-Topic", TOPIC)
      .set("X-Shopify-Shop-Domain", SHOP)
      .set("X-Shopify-Webhook-Id", WEBHOOK_ID)
      .send(PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "accepted" });
  });

  it("rejects a request with an invalid HMAC signature (401)", async () => {
    const app = await buildTestApp({
      SHOPIFY_WEBHOOK_SECRET: SECRET,
      APP_ENV: "development",
    });
    const badHmac = makeHmac("wrong-secret", PAYLOAD);

    const res = await request(app)
      .post("/api/webhooks/shopify")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", badHmac)
      .set("X-Shopify-Topic", TOPIC)
      .set("X-Shopify-Webhook-Id", WEBHOOK_ID)
      .send(PAYLOAD);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Invalid signature" });
  });

  it("rejects with 401 when secret is configured but HMAC header is missing", async () => {
    const app = await buildTestApp({
      SHOPIFY_WEBHOOK_SECRET: SECRET,
      APP_ENV: "development",
    });

    const res = await request(app)
      .post("/api/webhooks/shopify")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Topic", TOPIC)
      .set("X-Shopify-Webhook-Id", WEBHOOK_ID)
      .send(PAYLOAD);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Missing X-Shopify-Hmac-Sha256 header" });
  });

  it("validates HMAC over raw bytes, not re-serialized JSON", async () => {
    const app = await buildTestApp({
      SHOPIFY_WEBHOOK_SECRET: SECRET,
      APP_ENV: "development",
    });
    // Non-canonical whitespace — exact bytes must be preserved
    const nonCanonical = '{ "id" : 42 , "title":"Sofa" }';
    const hmac = makeHmac(SECRET, nonCanonical);

    const res = await request(app)
      .post("/api/webhooks/shopify")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", hmac)
      .set("X-Shopify-Topic", TOPIC)
      .set("X-Shopify-Webhook-Id", `${WEBHOOK_ID}-raw`)
      .send(nonCanonical);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "accepted" });
  });

  it("rejects when HMAC is computed from JSON.stringify (re-serialised) instead of raw bytes", async () => {
    const app = await buildTestApp({
      SHOPIFY_WEBHOOK_SECRET: SECRET,
      APP_ENV: "development",
    });
    const rawBody = '{"a":1, "b":2}';
    // HMAC computed from compact re-serialization — bytes differ → should fail
    const reserialised = JSON.stringify(JSON.parse(rawBody)); // '{"a":1,"b":2}'
    const badHmac = makeHmac(SECRET, reserialised);

    const res = await request(app)
      .post("/api/webhooks/shopify")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", badHmac)
      .set("X-Shopify-Webhook-Id", `${WEBHOOK_ID}-reserialised`)
      .send(rawBody);

    expect(res.status).toBe(401);
  });
});

// ── Production secret enforcement ─────────────────────────────────────────────

describe("POST /api/webhooks/shopify — production secret enforcement", () => {
  it("accepts unsigned requests in development when no secret is set", async () => {
    const app = await buildTestApp({
      SHOPIFY_WEBHOOK_SECRET: undefined,
      APP_ENV: "development",
    });

    const res = await request(app)
      .post("/api/webhooks/shopify")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Topic", TOPIC)
      .set("X-Shopify-Webhook-Id", `${WEBHOOK_ID}-dev`)
      .send(PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "accepted" });
  });

  it("rejects unsigned requests in production when no secret is set (503)", async () => {
    const app = await buildTestApp({
      SHOPIFY_WEBHOOK_SECRET: undefined,
      APP_ENV: "production",
    });

    const res = await request(app)
      .post("/api/webhooks/shopify")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Topic", TOPIC)
      .set("X-Shopify-Webhook-Id", `${WEBHOOK_ID}-prod-no-secret`)
      .send(PAYLOAD);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringContaining("not configured") });
  });

  it("rejects unsigned requests in preview (non-dev) when no secret is set (503)", async () => {
    const app = await buildTestApp({
      SHOPIFY_WEBHOOK_SECRET: undefined,
      APP_ENV: "preview",
    });

    const res = await request(app)
      .post("/api/webhooks/shopify")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Webhook-Id", `${WEBHOOK_ID}-preview-no-secret`)
      .send(PAYLOAD);

    expect(res.status).toBe(503);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("POST /api/webhooks/shopify — idempotency and error handling", () => {
  it("returns duplicate status for a conflicting insert (existing webhook ID)", async () => {
    // ON CONFLICT DO NOTHING → returning = [] (no rows inserted)
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    mockInsert.mockReturnValue({ values });

    const app = await buildTestApp({
      SHOPIFY_WEBHOOK_SECRET: SECRET,
      APP_ENV: "development",
    });
    const hmac = makeHmac(SECRET, PAYLOAD);

    const res = await request(app)
      .post("/api/webhooks/shopify")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", hmac)
      .set("X-Shopify-Topic", TOPIC)
      .set("X-Shopify-Webhook-Id", "duplicate-wh-id")
      .send(PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "duplicate" });
  });

  it("returns 500 on DB failure so Shopify will retry delivery", async () => {
    // Simulate a transient DB error
    const onConflictDoNothing = vi.fn().mockReturnValue({
      returning: vi.fn().mockRejectedValue(new Error("DB connection lost")),
    });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    mockInsert.mockReturnValue({ values });

    const app = await buildTestApp({
      SHOPIFY_WEBHOOK_SECRET: SECRET,
      APP_ENV: "development",
    });
    const hmac = makeHmac(SECRET, PAYLOAD);

    const res = await request(app)
      .post("/api/webhooks/shopify")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", hmac)
      .set("X-Shopify-Topic", TOPIC)
      .set("X-Shopify-Webhook-Id", `${WEBHOOK_ID}-db-fail`)
      .send(PAYLOAD);

    // Must NOT return 200 — Shopify needs a non-2xx to trigger a retry
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });
});
