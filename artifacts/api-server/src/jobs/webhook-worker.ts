/**
 * Webhook Worker — polls webhook_events for pending events and processes them.
 *
 * Claiming strategy:
 *   Uses an atomic `UPDATE … RETURNING` to claim a single event at a time,
 *   setting status='processing' before returning the row. This is safe even
 *   with multiple concurrent worker instances — no separate lock needed.
 *
 * Stale recovery:
 *   Events stuck in 'processing' for > 5 minutes (e.g. after a crash) are
 *   automatically reset to 'pending' so they can be retried.
 *
 * Retry backoff:
 *   Each failure increments retry_count. The event is eligible for retry only
 *   after a backoff delay computed from retry_count (30 s × 2^n, capped at 1 h).
 *
 * Handled topics:
 *   products/create    → full product + translation sync
 *   products/update    → full product + translation sync
 *   products/delete    → mark product archived
 *   inventory_levels/update → targeted inventory level update
 */

import { db, webhookEventsTable, productsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";
import { syncProduct, updateInventoryItem } from "../shopify/index";
import { sleep } from "../shopify/client";

const logger = rootLogger.child({ module: "webhook-worker" });

// ── Configuration ─────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_BASE_MS = 30_000; // 30 s
const MAX_BACKOFF_MS = 60 * 60 * 1_000; // 1 h
const STALE_PROCESSING_AGE_MS = 5 * 60 * 1_000; // 5 min

// Topics this worker handles
const HANDLED_TOPICS = new Set([
  "products/create",
  "products/update",
  "products/delete",
  "inventory_levels/update",
]);

// Row type returned by the claim query
interface ClaimedEvent {
  id: string;
  topic: string;
  payload: Record<string, unknown> | null;
  retry_count: number;
  [key: string]: unknown;
}

// ── Backoff helper ────────────────────────────────────────────────────────────

/**
 * Returns how long an event should wait after `retryCount` failures before it
 * becomes eligible for retry. Stored as `retry_after` in the DB.
 */
function nextRetryAfter(retryCount: number): Date {
  const backoff = Math.min(
    RETRY_BACKOFF_BASE_MS * Math.pow(2, retryCount - 1),
    MAX_BACKOFF_MS,
  );
  return new Date(Date.now() + backoff);
}

// ── Worker class ─────────────────────────────────────────────────────────────

export class WebhookWorker {
  private running = false;
  private loopPromise: Promise<void> | null = null;

  /** Start the polling loop. Safe to call multiple times (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info("Webhook worker started");
    this.loopPromise = this.loop().catch((err) => {
      logger.error({ err }, "Webhook worker loop crashed");
      this.running = false;
    });
  }

  /** Stop the worker gracefully — waits for the current cycle to finish. */
  async stop(): Promise<void> {
    logger.info("Webhook worker stopping...");
    this.running = false;
    await this.loopPromise;
    logger.info("Webhook worker stopped");
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        // First, recover any events stuck in 'processing' (worker crash recovery)
        await this.recoverStaleEvents();

        const claimed = await this.claimNextEvent();
        if (!claimed) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        await this.processEvent(claimed);
      } catch (err) {
        logger.error({ err }, "Webhook worker loop error — backing off");
        await sleep(POLL_INTERVAL_MS * 2);
      }
    }
  }

  /**
   * Atomically claim one pending event by flipping its status to 'processing'.
   * Uses UPDATE … RETURNING so the claim and status change are a single
   * database round-trip — safe with multiple concurrent workers.
   *
   * Only claims events whose retry_after is in the past (or NULL).
   */
  private async claimNextEvent(): Promise<ClaimedEvent | null> {
    // Use a subquery to find one eligible event, then UPDATE it atomically.
    // This avoids the TOCTOU gap of SELECT then UPDATE.
    const result = await db.execute<ClaimedEvent>(sql`
      UPDATE webhook_events
      SET    status = 'processing',
             updated_at = NOW()
      WHERE  id = (
               SELECT id
               FROM   webhook_events
               WHERE  status = 'pending'
                 AND  retry_count < ${MAX_RETRIES}
                 AND  (retry_after IS NULL OR retry_after <= NOW())
               ORDER  BY created_at ASC
               LIMIT  1
               FOR UPDATE SKIP LOCKED
             )
      RETURNING id, topic, payload, retry_count
    `);

    const rows = (result as unknown as { rows: ClaimedEvent[] }).rows;
    return rows[0] ?? null;
  }

  /**
   * Reset events that have been stuck in 'processing' for longer than
   * STALE_PROCESSING_AGE_MS (crash / OOM recovery).
   */
  private async recoverStaleEvents(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_PROCESSING_AGE_MS);
    const result = await db.execute<{ id: string }>(sql`
      UPDATE webhook_events
      SET    status = 'pending',
             updated_at = NOW()
      WHERE  status = 'processing'
        AND  updated_at < ${cutoff.toISOString()}
      RETURNING id
    `);
    const recovered = (result as unknown as { rows: Array<{ id: string }> }).rows;
    if (recovered.length > 0) {
      logger.warn({ count: recovered.length }, "Recovered stale processing webhook events");
    }
  }

  private async processEvent(event: ClaimedEvent): Promise<void> {
    const { id: eventId, topic, payload, retry_count: retryCount } = event;
    logger.debug({ eventId, topic }, "Processing webhook event");

    try {
      if (!HANDLED_TOPICS.has(topic)) {
        logger.debug({ topic, eventId }, "Unhandled webhook topic — skipping");
        await db
          .update(webhookEventsTable)
          .set({ status: "processed", processedAt: new Date() })
          .where(eq(webhookEventsTable.id, eventId));
        return;
      }

      await this.dispatchEvent(topic, payload);

      await db
        .update(webhookEventsTable)
        .set({ status: "processed", processedAt: new Date() })
        .where(eq(webhookEventsTable.id, eventId));

      logger.info({ eventId, topic }, "Webhook event processed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const newRetryCount = retryCount + 1;
      const isFinal = newRetryCount >= MAX_RETRIES;
      const retryAfter = isFinal ? null : nextRetryAfter(newRetryCount);

      logger.error(
        { eventId, topic, retryCount: newRetryCount, isFinal, retryAfter, err: message },
        "Webhook processing failed",
      );

      await db
        .update(webhookEventsTable)
        .set({
          status: isFinal ? "failed" : "pending",
          retryCount: newRetryCount,
          retryAfter,
          error: message,
        })
        .where(eq(webhookEventsTable.id, eventId));
    }
  }

  private async dispatchEvent(
    topic: string,
    payload: Record<string, unknown> | null,
  ): Promise<void> {
    switch (topic) {
      case "products/create":
      case "products/update": {
        const productId = payload?.["id"];
        if (!productId) throw new Error(`Missing id in ${topic} payload`);
        await syncProduct(String(productId));
        break;
      }

      case "products/delete": {
        const productId = payload?.["id"];
        if (!productId) throw new Error("Missing id in products/delete payload");
        // Mark archived — don't hard-delete (preserve analytics history)
        await db
          .update(productsTable)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(productsTable.shopifyGid, `gid://shopify/Product/${productId}`));
        logger.info({ productId }, "Product archived via webhook");
        break;
      }

      case "inventory_levels/update": {
        const inventoryItemId = payload?.["inventory_item_id"];
        if (!inventoryItemId) {
          throw new Error("Missing inventory_item_id in inventory_levels/update payload");
        }
        await updateInventoryItem(String(inventoryItemId));
        break;
      }

      default:
        logger.warn({ topic }, "Unmatched topic in dispatchEvent");
    }
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

let _worker: WebhookWorker | null = null;

export function getWebhookWorker(): WebhookWorker {
  if (!_worker) {
    _worker = new WebhookWorker();
  }
  return _worker;
}

/** Start the webhook worker singleton. Safe to call at app startup. */
export function startWebhookWorker(): void {
  getWebhookWorker().start();
}

/** Stop the webhook worker singleton gracefully. */
export async function stopWebhookWorker(): Promise<void> {
  await _worker?.stop();
}
