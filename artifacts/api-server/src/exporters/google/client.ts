/**
 * Google Merchant Center API Client
 *
 * Authenticates using a Service Account JSON (base64-encoded in
 * GOOGLE_SERVICE_ACCOUNT_JSON env var) and wraps the Content API v2.1
 * product upsert / delete / list operations.
 *
 * All write operations respect GOOGLE_DRY_RUN (default: true).
 * The merchant ID comes from GOOGLE_MERCHANT_ID env var.
 *
 * Spec reference: §30 (Google Merchant API, Content API v2.1).
 */

import { GoogleAuth } from "google-auth-library";
import { logger as rootLogger } from "../../lib/logger";
import type { GoogleProductResource } from "./mapper";

const logger = rootLogger.child({ module: "google-merchant-client" });

const CONTENT_API_BASE = "https://shoppingcontent.googleapis.com/content/v2.1";
const SCOPES = ["https://www.googleapis.com/auth/content"];
const MAX_BATCH_SIZE = 100; // Content API batch limit per request

// ── Config ────────────────────────────────────────────────────────────────────

function getMerchantId(): string {
  const id = process.env["GOOGLE_MERCHANT_ID"];
  if (!id) throw new Error("GOOGLE_MERCHANT_ID env var is not set");
  return id;
}

export function isDryRun(): boolean {
  const env = process.env["GOOGLE_DRY_RUN"];
  // Default true unless explicitly set to "false"
  return env !== "false";
}

// ── Auth ──────────────────────────────────────────────────────────────────────

let _auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (_auth) return _auth;

  const raw = process.env["GOOGLE_SERVICE_ACCOUNT_JSON"];
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var is not set");

  let credentials: Record<string, unknown>;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf-8");
    credentials = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid base64-encoded JSON");
  }

  _auth = new GoogleAuth({ credentials, scopes: SCOPES });
  return _auth;
}

async function getAccessToken(): Promise<string> {
  const auth = getAuth();
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) throw new Error("Failed to obtain Google access token");
  return tokenResponse.token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getAccessToken();
  const url = `${CONTENT_API_BASE}/${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Google Merchant API ${method} ${url} → ${res.status}: ${errorText}`);
  }

  if (res.status === 204 || method === "DELETE") return undefined as T;
  return res.json() as Promise<T>;
}

// ── Product resource → Content API shape ──────────────────────────────────────

function toContentApiProduct(resource: GoogleProductResource): Record<string, unknown> {
  const product: Record<string, unknown> = {
    offerId: resource.offerId,
    title: resource.title,
    description: resource.description,
    link: resource.link,
    imageLink: resource.imageLink,
    availability: resource.availability,
    price: resource.price,
    brand: resource.brand,
    identifierExists: resource.identifierExists,
    condition: resource.condition,
    channel: resource.channel,
    targetCountry: resource.targetCountry,
    contentLanguage: resource.contentLanguage,
    customLabel0: resource.customLabel0,
    customLabel1: resource.customLabel1,
    customLabel2: resource.customLabel2,
    customLabel3: resource.customLabel3,
    customLabel4: resource.customLabel4,
  };

  if (resource.additionalImageLinks.length > 0)
    product["additionalImageLinks"] = resource.additionalImageLinks;
  if (resource.lifestyleImageLinks.length > 0)
    product["lifestyleImageLinks"] = resource.lifestyleImageLinks;
  if (resource.salePrice) product["salePrice"] = resource.salePrice;
  if (resource.salePriceEffectiveDate) product["salePriceEffectiveDate"] = resource.salePriceEffectiveDate;
  if (resource.gtin) product["gtin"] = resource.gtin;
  if (resource.mpn) product["mpn"] = resource.mpn;
  if (resource.googleProductCategory) product["googleProductCategory"] = resource.googleProductCategory;
  if (resource.productTypes.length > 0) product["productTypes"] = resource.productTypes;
  if (resource.itemGroupId) product["itemGroupId"] = resource.itemGroupId;
  if (resource.color) product["color"] = resource.color;
  if (resource.material) product["material"] = resource.material;
  if (resource.shippingWeight) product["shippingWeight"] = resource.shippingWeight;
  if (resource.productDetails?.length) product["productDetails"] = resource.productDetails;
  if (resource.productHighlights?.length) product["productHighlights"] = resource.productHighlights;

  return product;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface UpsertResult {
  offerId: string;
  success: boolean;
  error?: string;
}

/**
 * Upsert a single product to Google Merchant Center.
 * In dry-run mode, logs the payload but does not call the API.
 */
export async function upsertProduct(
  resource: GoogleProductResource,
): Promise<UpsertResult> {
  const merchantId = getMerchantId();
  const offerId = resource.offerId;

  if (isDryRun()) {
    logger.info({ offerId, dryRun: true }, "DRY RUN: would upsert product");
    return { offerId, success: true };
  }

  try {
    const payload = toContentApiProduct(resource);
    await apiRequest<unknown>(
      "POST",
      `${merchantId}/products`,
      payload,
    );
    return { offerId, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ offerId, err: message }, "Failed to upsert product");
    return { offerId, success: false, error: message };
  }
}

/**
 * Upsert products in batches of MAX_BATCH_SIZE using the custombatch endpoint.
 * In dry-run mode, logs counts but does not call the API.
 */
export async function batchUpsertProducts(
  resources: GoogleProductResource[],
): Promise<{ succeeded: number; failed: number; errors: UpsertResult[] }> {
  const merchantId = getMerchantId();
  let succeeded = 0;
  let failed = 0;
  const errors: UpsertResult[] = [];

  if (isDryRun()) {
    logger.info(
      { count: resources.length, dryRun: true },
      "DRY RUN: would upsert products batch",
    );
    return { succeeded: resources.length, failed: 0, errors: [] };
  }

  // Chunk into batches
  for (let i = 0; i < resources.length; i += MAX_BATCH_SIZE) {
    const chunk = resources.slice(i, i + MAX_BATCH_SIZE);
    const batchEntries = chunk.map((r, idx) => ({
      batchId: i + idx,
      merchantId: parseInt(merchantId, 10),
      method: "insert",
      product: toContentApiProduct(r),
    }));

    try {
      const response = await apiRequest<{
        kind: string;
        entries: Array<{
          batchId: number;
          product?: Record<string, unknown>;
          errors?: { code: number; message: string };
        }>;
      }>("POST", "products/custombatch", { entries: batchEntries });

      for (const entry of response.entries ?? []) {
        const resource = chunk[entry.batchId - i];
        if (entry.errors) {
          failed++;
          errors.push({
            offerId: resource?.offerId ?? `batch-${entry.batchId}`,
            success: false,
            error: entry.errors.message,
          });
        } else {
          succeeded++;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ chunkStart: i, chunkSize: chunk.length, err: message }, "Batch upsert chunk failed");
      // Mark all in chunk as failed
      failed += chunk.length;
      for (const r of chunk) {
        errors.push({ offerId: r.offerId, success: false, error: message });
      }
    }

    logger.debug({ batchStart: i, batchEnd: Math.min(i + MAX_BATCH_SIZE, resources.length) }, "Batch chunk submitted");
  }

  return { succeeded, failed, errors };
}

/**
 * Delete a product from Google Merchant Center by product ID.
 * In dry-run mode, logs but does not call the API.
 */
export async function deleteProduct(productId: string): Promise<boolean> {
  const merchantId = getMerchantId();

  if (isDryRun()) {
    logger.info({ productId, dryRun: true }, "DRY RUN: would delete product");
    return true;
  }

  try {
    await apiRequest<void>("DELETE", `${merchantId}/products/${encodeURIComponent(productId)}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ productId, err: message }, "Failed to delete product");
    return false;
  }
}

/**
 * List all product IDs currently in Google Merchant Center for a given language+country.
 * Uses pagination to retrieve all pages.
 */
export async function listProductIds(
  language: string,
  country: string,
): Promise<string[]> {
  const merchantId = getMerchantId();
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });

    const response = await apiRequest<{
      resources?: Array<{ id: string; offerId: string; contentLanguage: string; targetCountry: string }>;
      nextPageToken?: string;
    }>("GET", `${merchantId}/products?${params.toString()}`);

    for (const product of response.resources ?? []) {
      if (
        product.contentLanguage === language &&
        product.targetCountry === country
      ) {
        ids.push(product.id);
      }
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  return ids;
}

/**
 * Batch delete products from Google Merchant Center.
 * In dry-run mode, logs counts but does not call the API.
 */
export async function batchDeleteProducts(productIds: string[]): Promise<{
  deleted: number;
  failed: number;
}> {
  const merchantId = getMerchantId();
  let deleted = 0;
  let failed = 0;

  if (isDryRun()) {
    logger.info({ count: productIds.length, dryRun: true }, "DRY RUN: would delete products");
    return { deleted: productIds.length, failed: 0 };
  }

  for (let i = 0; i < productIds.length; i += MAX_BATCH_SIZE) {
    const chunk = productIds.slice(i, i + MAX_BATCH_SIZE);
    const batchEntries = chunk.map((id, idx) => ({
      batchId: i + idx,
      merchantId: parseInt(merchantId, 10),
      method: "delete",
      productId: id,
    }));

    try {
      const response = await apiRequest<{
        entries?: Array<{
          batchId: number;
          errors?: { code: number; message: string };
        }>;
      }>("POST", "products/custombatch", { entries: batchEntries });

      // Inspect per-entry results — an HTTP-200 custombatch can still contain
      // per-entry failures; do NOT count all as deleted on HTTP success.
      for (const entry of response.entries ?? []) {
        const productId = chunk[entry.batchId - i];
        if (entry.errors) {
          failed++;
          logger.error(
            { productId, err: entry.errors.message, code: entry.errors.code },
            "Batch delete entry failed",
          );
        } else {
          deleted++;
        }
      }
      // If the response contained no entries array (should not happen), be
      // conservative: count as deleted so the caller can reconcile.
      if (!response.entries) {
        logger.warn({ chunkStart: i, count: chunk.length }, "Custombatch delete: no entries in response, assuming all deleted");
        deleted += chunk.length;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ chunkStart: i, err: message }, "Batch delete chunk failed");
      failed += chunk.length;
    }
  }

  return { deleted, failed };
}
