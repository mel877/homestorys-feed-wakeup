/**
 * Shopify Admin GraphQL client.
 *
 * Features:
 * - Cost-aware rate limiting (token bucket from extensions.cost)
 * - Exponential backoff + jitter for 429/5xx (max 6 retries)
 * - Scope validation via REST API at startup
 * - Access token is never logged
 */

import { logger as rootLogger } from "../lib/logger";
import type { GraphQLResponse, ThrottleStatus, CostExtension, ShopifyAccessScope } from "./types";

const logger = rootLogger.child({ module: "shopify-client" });

// ── Errors ────────────────────────────────────────────────────────────────────

export class ShopifyGraphQLError extends Error {
  constructor(
    public readonly errors: Array<{ message: string; path?: string[] }>,
  ) {
    super(errors.map((e) => e.message).join("; "));
    this.name = "ShopifyGraphQLError";
  }
}

export class ShopifyRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Shopify rate limit hit — retry after ${retryAfterMs}ms`);
    this.name = "ShopifyRateLimitError";
  }
}

export class ShopifyScopeError extends Error {
  constructor(public readonly missingScopes: string[]) {
    super(`Missing Shopify API scopes: ${missingScopes.join(", ")}`);
    this.name = "ShopifyScopeError";
  }
}

// ── Rate limiter ──────────────────────────────────────────────────────────────

class RateLimiter {
  private currentlyAvailable: number;
  private maximumAvailable: number;
  private restoreRate: number; // points per second
  private lastUpdateTime: number;

  constructor() {
    // Shopify GraphQL default limits
    this.currentlyAvailable = 2000;
    this.maximumAvailable = 2000;
    this.restoreRate = 100;
    this.lastUpdateTime = Date.now();
  }

  update(cost: CostExtension): void {
    const { throttleStatus } = cost;
    this.currentlyAvailable = throttleStatus.currentlyAvailable;
    this.maximumAvailable = throttleStatus.maximumAvailable;
    this.restoreRate = throttleStatus.restoreRate;
    this.lastUpdateTime = Date.now();

    logger.debug(
      {
        available: throttleStatus.currentlyAvailable,
        maximum: throttleStatus.maximumAvailable,
        actualCost: cost.actualQueryCost,
      },
      "Rate limiter updated",
    );
  }

  async waitIfNeeded(requestedCost = 100): Promise<void> {
    // Project currently available tokens forward in time
    const elapsedMs = Date.now() - this.lastUpdateTime;
    const restored = (elapsedMs / 1000) * this.restoreRate;
    const projected = Math.min(
      this.maximumAvailable,
      this.currentlyAvailable + restored,
    );

    if (projected < requestedCost) {
      const needed = requestedCost - projected;
      const waitSeconds = needed / this.restoreRate;
      const waitMs = Math.ceil(waitSeconds * 1000) + 200; // 200ms buffer
      logger.debug({ waitMs, needed, restoreRate: this.restoreRate }, "Rate limiter waiting");
      await sleep(waitMs);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(maxMs = 1000): number {
  return Math.floor(Math.random() * maxMs);
}

function extractNumericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

// ── ShopifyClient ─────────────────────────────────────────────────────────────

export class ShopifyClient {
  readonly shopDomain: string;
  readonly apiVersion: string;
  readonly graphqlEndpoint: string;
  readonly restBase: string;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly rateLimiter: RateLimiter;
  /** Cached short-lived token from client credentials grant (24h, Shopify docs). */
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor() {
    this.shopDomain = requireEnv("SHOPIFY_SHOP_DOMAIN");
    // Accept either a permanent Admin API token (custom apps) or client
    // credentials (Dev Dashboard / partner apps). Token takes priority.
    this.clientId = process.env["SHOPIFY_CLIENT_ID"] ?? "";
    this.clientSecret = process.env["SHOPIFY_CLIENT_SECRET"] ?? "";
    this.apiVersion = process.env["SHOPIFY_API_VERSION"] ?? "2025-01";

    this.graphqlEndpoint = `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
    this.restBase = `https://${this.shopDomain}/admin/api/${this.apiVersion}`;
    this.rateLimiter = new RateLimiter();
  }

  /**
   * Return a valid Shopify Admin API access token.
   *
   * Strategy (in order):
   *  1. SHOPIFY_ADMIN_ACCESS_TOKEN env var — permanent token for custom apps
   *     created in Shopify Admin. Never expires; used as-is.
   *  2. Client credentials grant — for Dev Dashboard / partner apps that
   *     have been OAuth-installed on the shop. Tokens last ~24h and are
   *     cached with a 30-minute refresh buffer.
   *
   * Never logs the token value.
   */
  private async getAccessToken(): Promise<string> {
    // Strategy 1: permanent admin token (custom apps).
    const staticToken = process.env["SHOPIFY_ADMIN_ACCESS_TOKEN"];
    if (staticToken) return staticToken;

    // Strategy 2: client credentials grant (partner / Dev Dashboard apps).
    if (!this.clientId || !this.clientSecret) {
      throw new Error(
        "Shopify: set SHOPIFY_ADMIN_ACCESS_TOKEN (custom app) or " +
        "both SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (partner app).",
      );
    }

    const now = Date.now();
    if (this.cachedToken && now < this.cachedToken.expiresAt) {
      return this.cachedToken.value;
    }

    const url = `https://${this.shopDomain}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Shopify token exchange failed: ${response.status} ${text}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    // Cache with 30-minute safety buffer so we refresh before actual expiry.
    const expiresAt = now + (data.expires_in - 1800) * 1000;
    this.cachedToken = { value: data.access_token, expiresAt };
    logger.info("Shopify access token refreshed via client credentials grant");
    return data.access_token;
  }

  /**
   * Execute a GraphQL query or mutation.
   * Retries on 429 / 5xx with exponential backoff + jitter.
   * Never logs the access token.
   */
  async request<T>(
    query: string,
    variables?: Record<string, unknown>,
    opts: { expectedCost?: number } = {},
  ): Promise<T> {
    await this.rateLimiter.waitIfNeeded(opts.expectedCost ?? 50);

    const maxRetries = 6;
    let attempt = 0;

    while (attempt <= maxRetries) {
      let response: Response;
      try {
        response = await fetch(this.graphqlEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": await this.getAccessToken(),
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        // Network error — retry
        if (attempt >= maxRetries) throw err;
        const backoff = Math.min(1000 * 2 ** attempt + jitter(), 60_000);
        logger.warn({ attempt, backoff }, "Network error — retrying");
        await sleep(backoff);
        attempt++;
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter =
          parseInt(response.headers.get("Retry-After") ?? "0") * 1000;
        const backoff = Math.max(
          retryAfter,
          Math.min(1000 * 2 ** attempt + jitter(), 60_000),
        );
        logger.warn(
          { status: response.status, attempt, backoff },
          "HTTP error — retrying",
        );
        await sleep(backoff);
        attempt++;
        continue;
      }

      const body = (await response.json()) as GraphQLResponse<T>;

      // Update rate limiter from cost extension
      if (body.extensions?.cost) {
        this.rateLimiter.update(body.extensions.cost);
      }

      // Handle throttled errors
      // Shopify sometimes returns `errors` as a plain string (e.g. when the
      // access token is invalid after an app reinstall) instead of an array.
      // Normalize to array so .some() never throws.
      if (body.errors?.length) {
        const errorsArray: Array<{ message: string; extensions?: { code?: string } }> =
          Array.isArray(body.errors)
            ? body.errors
            : [{ message: String(body.errors) }];

        const throttled = errorsArray.some(
          (e) =>
            e.message.toLowerCase().includes("throttled") ||
            e.extensions?.code === "THROTTLED",
        );

        if (throttled && attempt < maxRetries) {
          // waitIfNeeded returns void — it already sleeps internally.
          // Add exponential backoff on top for safety.
          await this.rateLimiter.waitIfNeeded(500);
          const backoff = Math.min(2000 * 2 ** attempt + jitter(), 60_000);
          logger.warn({ attempt, backoff }, "GraphQL throttled — retrying");
          await sleep(backoff);
          attempt++;
          continue;
        }

        // If Shopify returns an "unauthorized" error it means the cached token
        // was revoked (e.g. app reinstall). Clear it so the next attempt gets
        // a fresh token via client-credentials grant.
        const isUnauthorized = errorsArray.some(
          (e) =>
            e.message.toLowerCase().includes("unauthorized") ||
            e.message.toLowerCase().includes("invalid api key") ||
            e.message.toLowerCase().includes("access token") ||
            e.extensions?.code === "UNAUTHORIZED",
        );
        if (isUnauthorized) {
          this.cachedToken = null;
          if (attempt < maxRetries) {
            logger.warn({ attempt }, "GraphQL unauthorized — clearing token cache and retrying");
            attempt++;
            continue;
          }
        }

        throw new ShopifyGraphQLError(errorsArray);
      }

      return body.data;
    }

    throw new Error(`Shopify GraphQL request failed after ${maxRetries} retries`);
  }

  /**
   * Execute a REST API request (used for scope validation).
   * Never logs the access token.
   */
  async requestRest<T>(path: string): Promise<T> {
    const response = await fetch(`${this.restBase}${path}`, {
      headers: {
        "X-Shopify-Access-Token": await this.getAccessToken(),
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      // 401 means the cached token was revoked (e.g. app reinstall). Clear it
      // so the next GraphQL call triggers a fresh client-credentials grant.
      if (response.status === 401) {
        this.cachedToken = null;
      }
      throw new Error(`Shopify REST ${path} → ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  /**
   * Validate that the access token has all required Admin API scopes.
   * Logs scope names only — never the token itself.
   */
  async validateScopes(required: string[]): Promise<void> {
    let granted: ShopifyAccessScope[];

    try {
      const result = await this.requestRest<{ access_scopes: ShopifyAccessScope[] }>(
        "/access_scopes.json",
      );
      granted = result.access_scopes;
    } catch (err) {
      logger.warn({ err }, "Could not verify Shopify API scopes — continuing");
      return;
    }

    const grantedSet = new Set(granted.map((s) => s.handle));
    const missing = required.filter((s) => !grantedSet.has(s));

    if (missing.length > 0) {
      logger.error({ missing, granted: [...grantedSet] }, "Missing required Shopify scopes");
      throw new ShopifyScopeError(missing);
    }

    logger.info({ granted: granted.map((s) => s.handle) }, "Shopify scopes validated");
  }

  /** Fetch basic shop information (does not include the token). */
  async getShopInfo(): Promise<{ name: string; myshopifyDomain: string }> {
    const query = `{ shop { name myshopifyDomain } }`;
    const result = await this.request<{ shop: { name: string; myshopifyDomain: string } }>(query);
    return result.shop;
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

let _client: ShopifyClient | null = null;

export function getShopifyClient(): ShopifyClient {
  if (!_client) {
    _client = new ShopifyClient();
  }
  return _client;
}

export function resetShopifyClient(): void {
  _client = null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return val;
}

export { extractNumericId, sleep };
