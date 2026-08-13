import { Router, type IRouter } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@workspace/db";
import { webhookEventsTable } from "@workspace/db";

const router: IRouter = Router();

/**
 * Returns true when the server is explicitly running in a development/test
 * environment.  Production and preview environments are treated identically:
 * they are NOT development.
 */
function isDevEnv(): boolean {
  const env = process.env["APP_ENV"] ?? process.env["NODE_ENV"] ?? "production";
  return env === "development" || env === "test";
}

/**
 * POST /api/webhooks/shopify
 *
 * Receives Shopify webhook events.
 *
 * Security model:
 * - In any non-development environment SHOPIFY_WEBHOOK_SECRET MUST be set;
 *   missing secret → 503 (do not silently accept unsigned requests).
 * - When the secret is set the X-Shopify-Hmac-Sha256 header is required;
 *   missing or invalid header → 401.
 * - HMAC is computed directly from the raw request Buffer (express.raw applied
 *   in app.ts) so that Shopify's byte-exact signature is validated correctly.
 *
 * Idempotency:
 * - Uses atomic INSERT … ON CONFLICT DO NOTHING keyed on the unique
 *   shopify_webhook_id column.  The unique constraint prevents duplicate rows
 *   even under concurrent delivery.
 *
 * Error handling:
 * - DB write failures return HTTP 500 so that Shopify will retry delivery.
 *   (Returning 200 on failure would signal success and prevent retries.)
 */
router.post("/shopify", async (req, res) => {
  const webhookSecret = process.env["SHOPIFY_WEBHOOK_SECRET"];

  const hmacHeader = req.headers["x-shopify-hmac-sha256"] as string | undefined;
  const webhookId =
    (req.headers["x-shopify-webhook-id"] as string | undefined) ??
    `${Date.now()}-${Math.random()}`;
  const topic =
    (req.headers["x-shopify-topic"] as string | undefined) ?? "unknown";
  const shopDomain =
    (req.headers["x-shopify-shop-domain"] as string | undefined) ?? "";

  // ── Secret presence check ──────────────────────────────────────────────────
  if (!webhookSecret) {
    if (isDevEnv()) {
      // Development only: accept without verification but log a prominent warning
      req.log.warn(
        { topic, webhookId },
        "SHOPIFY_WEBHOOK_SECRET not set — HMAC verification skipped (development only)",
      );
    } else {
      // Production / preview: fail closed — never accept unsigned webhooks
      req.log.error(
        { topic, webhookId },
        "SHOPIFY_WEBHOOK_SECRET is required in production but is not set",
      );
      res.status(503).json({
        error: "Webhook endpoint not configured — contact administrator",
      });
      return;
    }
  } else {
    // ── HMAC header presence check ───────────────────────────────────────────
    if (!hmacHeader) {
      req.log.warn({ topic, webhookId }, "Shopify webhook rejected: missing HMAC header");
      res.status(401).json({ error: "Missing X-Shopify-Hmac-Sha256 header" });
      return;
    }

    // ── HMAC signature verification ──────────────────────────────────────────
    // req.body is a Buffer — express.raw() applied in app.ts before this route
    const rawBody = req.body as Buffer;
    const digest = createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("base64");

    const digestBuf = Buffer.from(digest);
    const hmacBuf = Buffer.from(hmacHeader);

    const isValid =
      digestBuf.length === hmacBuf.length &&
      timingSafeEqual(digestBuf, hmacBuf);

    if (!isValid) {
      req.log.warn({ topic, webhookId }, "Shopify webhook rejected: invalid HMAC signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  }

  // ── Parse JSON payload from raw Buffer ────────────────────────────────────
  // Manual parse after HMAC verification — ensures we only deserialize verified bytes.
  let payload: Record<string, unknown> = {};
  try {
    const rawBody = req.body as Buffer;
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    req.log.warn({ topic, webhookId }, "Shopify webhook: unparseable JSON body (empty body topics accepted)");
  }

  // ── Atomic upsert with idempotency ────────────────────────────────────────
  // INSERT … ON CONFLICT DO NOTHING is safe under concurrent duplicate delivery.
  // The unique constraint on shopify_webhook_id prevents duplicates at DB level.
  try {
    const inserted = await db
      .insert(webhookEventsTable)
      .values({
        shopifyWebhookId: webhookId,
        topic,
        shopifyDomain: shopDomain,
        payload,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: webhookEventsTable.id });

    if (inserted.length === 0) {
      req.log.info({ webhookId }, "Duplicate webhook event — skipped via conflict");
      res.json({ status: "duplicate" });
      return;
    }

    req.log.info({ webhookId, topic }, "Webhook event persisted");
    res.json({ status: "accepted" });
  } catch (err) {
    req.log.error({ err, webhookId }, "Failed to persist webhook event");
    // Return 500 so Shopify will retry delivery on transient DB failures.
    res.status(500).json({ error: "Internal error — please retry" });
  }
});

export default router;
