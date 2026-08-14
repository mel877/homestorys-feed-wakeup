/**
 * Google Local Inventory
 *
 * Pushes Eupen showroom stock to the Google Merchant Inventories sub-API.
 * Only products with pickupEupen=true and stockEupen > 0 are included.
 *
 * Env vars required:
 *   GOOGLE_MERCHANT_ID       — numeric merchant account ID
 *   GOOGLE_SERVICE_ACCOUNT_JSON — base64-encoded service account JSON
 *   GOOGLE_EUPEN_STORE_CODE  — store code in Google Merchant Center
 *
 * Spec reference: §30 (local inventory), §20 (inventory labels).
 */

import { GoogleAuth } from "google-auth-library";
import { logger as rootLogger } from "../../lib/logger";
import type { CanonicalProduct } from "../../canonical/types";
import { isDryRun } from "./client";

const logger = rootLogger.child({ module: "google-local-inventory" });

const CONTENT_API_BASE = "https://shoppingcontent.googleapis.com/content/v2.1";
const SCOPES = ["https://www.googleapis.com/auth/content"];
const BATCH_SIZE = 100;

// ── Auth ──────────────────────────────────────────────────────────────────────

let _auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (_auth) return _auth;
  const raw = process.env["GOOGLE_SERVICE_ACCOUNT_JSON"];
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const credentials = JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as Record<string, unknown>;
  _auth = new GoogleAuth({ credentials, scopes: SCOPES });
  return _auth;
}

async function getToken(): Promise<string> {
  const client = await getAuth().getClient();
  const res = await client.getAccessToken();
  if (!res.token) throw new Error("Failed to get Google access token");
  return res.token;
}

async function apiRequest<T>(
  method: "POST" | "GET",
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getToken();
  const url = `${CONTENT_API_BASE}/${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Local inventory API ${method} ${url} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LocalInventoryEntry {
  offerId: string;
  storeCode: string;
  quantity: number;
  availability: string;
  pickup: "same day" | "multi-day" | "not supported";
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Push local inventory for all Eupen showroom products.
 * Only products with pickupEupen=true are included.
 *
 * @deprecated Prefer `submitLocalInventoryEntries` which accepts pre-built
 * entries and avoids holding full CanonicalProduct objects in memory.
 */
export async function syncLocalInventory(
  canonicals: CanonicalProduct[],
  country: string,
  language: string,
): Promise<{ submitted: number; failed: number }> {
  const storeCode = process.env["GOOGLE_EUPEN_STORE_CODE"] ?? "";

  const entries: LocalInventoryEntry[] = canonicals
    .filter((c) => c.pickupEupen && (c.stockEupen ?? 0) > 0)
    .map((c) => ({
      offerId: `online:${c.language}:${country}:${c.variantId}`,
      storeCode,
      quantity: c.stockEupen ?? 0,
      availability: "in stock",
      pickup: "multi-day",
    }));

  return submitLocalInventoryEntries(entries);
}

/**
 * Submit pre-built LocalInventoryEntry objects to the Merchant Inventories API.
 *
 * Use this in streaming pipelines where you build entries on-the-fly and
 * cannot afford to hold full CanonicalProduct objects in memory.
 */
export async function submitLocalInventoryEntries(
  entries: LocalInventoryEntry[],
): Promise<{ submitted: number; failed: number }> {
  const merchantId = process.env["GOOGLE_MERCHANT_ID"];
  if (!merchantId) throw new Error("GOOGLE_MERCHANT_ID not set");

  const storeCode = process.env["GOOGLE_EUPEN_STORE_CODE"] ?? "";
  if (!storeCode) {
    logger.warn("GOOGLE_EUPEN_STORE_CODE not set — skipping local inventory sync");
    return { submitted: 0, failed: 0 };
  }

  if (entries.length === 0) {
    logger.info("No products with Eupen showroom stock — skipping local inventory");
    return { submitted: 0, failed: 0 };
  }

  if (isDryRun()) {
    logger.info(
      { count: entries.length, storeCode, dryRun: true },
      "DRY RUN: would sync local inventory",
    );
    return { submitted: entries.length, failed: 0 };
  }

  let submitted = 0;
  let failed = 0;

  // Batch into custombatch requests.
  // The productId sent to localinventory.custombatch must exactly match the
  // offerId used when the product was uploaded (the mapper's full form:
  // "online:{language}:{country}:{variantId}"). Do NOT prepend country/language again.
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const chunk = entries.slice(i, i + BATCH_SIZE);
    const batchEntries = chunk.map((entry, idx) => ({
      batchId: i + idx,
      merchantId: parseInt(merchantId, 10),
      storeCode: entry.storeCode,
      // offerId already contains the complete product identifier as uploaded
      productId: entry.offerId,
      method: "insert",
      localInventory: {
        storeCode: entry.storeCode,
        quantity: entry.quantity,
        availability: entry.availability,
        pickup: entry.pickup,
      },
    }));

    try {
      const response = await apiRequest<{
        entries?: Array<{
          batchId: number;
          errors?: { code: number; message: string };
        }>;
      }>("POST", "localinventory/custombatch", { entries: batchEntries });

      // Inspect per-entry results — an HTTP-200 batch can still contain entry-level errors
      for (const entry of response.entries ?? []) {
        const sourceEntry = chunk[entry.batchId - i];
        if (entry.errors) {
          failed++;
          logger.error(
            { offerId: sourceEntry?.offerId, storeCode: sourceEntry?.storeCode, err: entry.errors.message },
            "Local inventory entry failed",
          );
        } else {
          submitted++;
        }
      }
      // If response had no entries array at all (unexpected), count all as submitted
      if (!response.entries) {
        submitted += chunk.length;
      }

      logger.debug({ batchStart: i, count: chunk.length }, "Local inventory batch processed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ batchStart: i, err: message }, "Local inventory batch failed");
      failed += chunk.length;
    }
  }

  logger.info({ submitted, failed, storeCode }, "Local inventory sync complete");
  return { submitted, failed };
}

