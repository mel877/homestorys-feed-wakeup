/**
 * Google Merchant Diagnostics
 *
 * Fetches product-level diagnostics from the Google Merchant Center Content API
 * and persists them to the channel_diagnostics table.
 *
 * Issue types mapped to our schema:
 *   refusal           — product disapproved
 *   price_mismatch    — price inconsistency warning
 *   image             — image quality issues
 *   gtin              — GTIN validation warnings
 *   landing_page      — landing page crawl errors
 *   policy            — policy violations
 *
 * Spec reference: §30 (diagnostics pull).
 */

import { GoogleAuth } from "google-auth-library";
import { db, channelDiagnosticsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger as rootLogger } from "../../lib/logger";
import type { InsertChannelDiagnostic } from "@workspace/db";

const logger = rootLogger.child({ module: "google-diagnostics" });

const CONTENT_API_BASE = "https://shoppingcontent.googleapis.com/content/v2.1";
const SCOPES = ["https://www.googleapis.com/auth/content"];

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

async function apiGet<T>(path: string): Promise<T> {
  const token = await getToken();
  const url = `${CONTENT_API_BASE}/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Diagnostics API GET ${url} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Issue type mapping ────────────────────────────────────────────────────────

type IssueType =
  | "refusal"
  | "price_mismatch"
  | "availability_mismatch"
  | "gtin"
  | "image"
  | "landing_page"
  | "policy";

type Severity = "critical" | "error" | "warning" | "info";

interface GoogleIssue {
  code: string;
  servability: string;
  resolution: string;
  attributeName?: string;
  description: string;
  detail?: string;
}

function classifyIssue(issue: GoogleIssue): { type: IssueType; severity: Severity } {
  const code = issue.code.toLowerCase();
  const servability = issue.servability.toLowerCase();

  // Severity from Google servability
  let severity: Severity = "warning";
  if (servability === "disapproved") severity = "critical";
  else if (servability === "demoted") severity = "error";

  // Type from code/attribute
  if (code.includes("price")) return { type: "price_mismatch", severity };
  if (code.includes("image")) return { type: "image", severity };
  if (code.includes("gtin") || code.includes("identifier")) return { type: "gtin", severity };
  if (code.includes("landing") || code.includes("url") || code.includes("link")) return { type: "landing_page", severity };
  if (code.includes("policy") || code.includes("prohibited")) return { type: "policy", severity };
  if (servability === "disapproved") return { type: "refusal", severity };
  return { type: "policy", severity };
}

// ── Diagnostics fetcher ───────────────────────────────────────────────────────

interface ProductStatus {
  productId: string;
  creationDate: string;
  lastUpdateDate: string;
  googleExpirationDate: string;
  title: string;
  productLevelIssues?: GoogleIssue[];
  destinationStatuses?: Array<{
    destination: string;
    status: string;
    pendingCountries?: string[];
    approvedCountries?: string[];
    disapprovedCountries?: string[];
    itemLevelIssues?: GoogleIssue[];
  }>;
}

/**
 * Fetch all product statuses from Google Merchant Center and persist
 * any issues to the channel_diagnostics table.
 *
 * Returns counts of issues fetched.
 */
export async function fetchAndStoreDiagnostics(
  marketCode?: string,
): Promise<{ total: number; critical: number; errors: number; warnings: number }> {
  const merchantId = process.env["GOOGLE_MERCHANT_ID"];
  if (!merchantId) {
    logger.warn("GOOGLE_MERCHANT_ID not set — skipping diagnostics fetch");
    return { total: 0, critical: 0, errors: 0, warnings: 0 };
  }

  logger.info({ merchantId, marketCode }, "Fetching Google Merchant diagnostics");

  const fetchedAt = new Date();
  const issues: InsertChannelDiagnostic[] = [];
  let pageToken: string | undefined;

  try {
    do {
      const params = new URLSearchParams({
        maxResults: "250",
        destinations: "Shopping",
        ...(pageToken ? { pageToken } : {}),
      });

      const response = await apiGet<{
        resources?: ProductStatus[];
        nextPageToken?: string;
      }>(`${merchantId}/productstatuses?${params.toString()}`);

      for (const status of response.resources ?? []) {
        // Product-level issues
        for (const issue of status.productLevelIssues ?? []) {
          const { type, severity } = classifyIssue(issue);
          issues.push({
            channel: "google",
            marketCode: marketCode ?? null,
            productIdExternal: status.productId,
            variantId: null,
            issueType: type,
            severity,
            message: issue.description.slice(0, 500),
            details: {
              code: issue.code,
              attributeName: issue.attributeName,
              detail: issue.detail,
              servability: issue.servability,
              resolution: issue.resolution,
              googleTitle: status.title,
            },
            fetchedAt,
            resolvedAt: null,
          });
        }

        // Destination-level item issues (Shopping destination)
        for (const dest of status.destinationStatuses ?? []) {
          if (dest.destination !== "Shopping") continue;
          for (const issue of dest.itemLevelIssues ?? []) {
            const { type, severity } = classifyIssue(issue);
            issues.push({
              channel: "google",
              marketCode: marketCode ?? null,
              productIdExternal: status.productId,
              variantId: null,
              issueType: type,
              severity,
              message: issue.description.slice(0, 500),
              details: {
                code: issue.code,
                attributeName: issue.attributeName,
                detail: issue.detail,
                servability: issue.servability,
                disapprovedCountries: dest.disapprovedCountries,
                destination: dest.destination,
              },
              fetchedAt,
              resolvedAt: null,
            });
          }
        }
      }

      pageToken = response.nextPageToken;
    } while (pageToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Failed to fetch Google diagnostics");
    throw err;
  }

  // Persist to DB
  if (issues.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < issues.length; i += CHUNK) {
      await db.insert(channelDiagnosticsTable).values(issues.slice(i, i + CHUNK));
    }
    logger.info({ count: issues.length }, "Google diagnostics stored");
  } else {
    logger.info("No issues found in Google diagnostics");
  }

  const critical = issues.filter((i) => i.severity === "critical").length;
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;

  return { total: issues.length, critical, errors, warnings };
}
