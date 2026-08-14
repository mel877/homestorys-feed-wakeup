/**
 * Alerting system.
 *
 * Checks alert conditions after each sync run and:
 *   1. Logs alert to sync_errors with errorType = "alert_*"
 *   2. POSTs to ALERT_WEBHOOK_URL if configured
 *
 * Alert conditions (spec §43):
 *   - Full sync failure
 *   - Product count drop > policy threshold (%)
 *   - Price invalidity > policy threshold (%)
 *   - Meta feed not regenerated within policy window
 *   - Inventory not refreshed within policy window
 *   - Auth failure (sync failed with 401/403-type errors)
 *   - Critical Merchant Center diagnostics
 */

import { db, syncRunsTable, syncErrorsTable, feedSnapshotsTable, channelDiagnosticsTable, productsTable, productTranslationsTable } from "@workspace/db";
import { eq, and, gte, desc, gt, inArray, count, isNull, sql, ne } from "drizzle-orm";
import { logger as rootLogger } from "../lib/logger";
import { loadConfig } from "../config/loader";

const logger = rootLogger.child({ module: "alerts" });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Alert {
  type: string;
  severity: "critical" | "warning" | "info";
  message: string;
  details?: Record<string, unknown>;
}

// ── Webhook delivery ──────────────────────────────────────────────────────────

async function postWebhook(alerts: Alert[]): Promise<void> {
  const url = process.env["ALERT_WEBHOOK_URL"];
  if (!url || alerts.length === 0) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "homestorys-feed-engine",
        timestamp: new Date().toISOString(),
        alerts,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, url }, "Alert webhook returned non-2xx status");
    } else {
      logger.info({ alertCount: alerts.length }, "Alerts posted to webhook");
    }
  } catch (err) {
    logger.error({ err, url }, "Failed to post alerts to webhook");
  }
}

// ── DB alert logging ──────────────────────────────────────────────────────────

async function logAlertsToDb(
  alerts: Alert[],
  syncRunId: string | null,
): Promise<void> {
  if (alerts.length === 0) return;
  await db.insert(syncErrorsTable).values(
    alerts.map((a) => ({
      syncRunId: syncRunId ?? undefined,
      errorType: `alert_${a.type}`,
      message: a.message,
      details: { severity: a.severity, ...a.details },
    })),
  );
}

// ── Alert condition checks ────────────────────────────────────────────────────

/**
 * Check if the latest full sync run failed.
 */
async function checkFullSyncFailure(): Promise<Alert[]> {
  const [latest] = await db
    .select({ status: syncRunsTable.status, id: syncRunsTable.id })
    .from(syncRunsTable)
    .where(eq(syncRunsTable.runType, "full"))
    .orderBy(desc(syncRunsTable.startedAt))
    .limit(1);

  if (latest?.status === "failed") {
    return [
      {
        type: "full_sync_failed",
        severity: "critical",
        message: "Last full sync run failed",
        details: { runId: latest.id },
      },
    ];
  }
  return [];
}

/**
 * Check for product count drop > threshold between last two full sync runs.
 */
async function checkProductCountDrop(thresholdPct: number): Promise<Alert[]> {
  const runs = await db
    .select({
      id: syncRunsTable.id,
      recordsRead: syncRunsTable.recordsRead,
      status: syncRunsTable.status,
    })
    .from(syncRunsTable)
    .where(
      and(
        eq(syncRunsTable.runType, "full"),
        eq(syncRunsTable.status, "completed"),
      ),
    )
    .orderBy(desc(syncRunsTable.startedAt))
    .limit(2);

  if (runs.length < 2) return [];

  const [latest, previous] = runs as [typeof runs[0], typeof runs[0]];
  const drop = previous.recordsRead > 0
    ? ((previous.recordsRead - latest.recordsRead) / previous.recordsRead) * 100
    : 0;

  if (drop > thresholdPct) {
    return [
      {
        type: "product_count_drop",
        severity: "critical",
        message: `Product count dropped ${drop.toFixed(1)}% (threshold: ${thresholdPct}%)`,
        details: {
          previous: previous.recordsRead,
          current: latest.recordsRead,
          dropPct: drop,
          thresholdPct,
        },
      },
    ];
  }
  return [];
}

/**
 * Check for price invalidity rate > threshold.
 *
 * Only considers CURRENT diagnostics: unresolved rows (resolvedAt IS NULL)
 * fetched within the last 48 hours. Historical/resolved issues are excluded
 * so the alert clears once they are fixed and re-fetched from Google.
 */
async function checkPriceInvalidity(thresholdPct: number): Promise<Alert[]> {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1_000);

    const allDiags = await db
      .select({ issueType: channelDiagnosticsTable.issueType })
      .from(channelDiagnosticsTable)
      .where(
        and(
          eq(channelDiagnosticsTable.channel, "google"),
          isNull(channelDiagnosticsTable.resolvedAt),        // unresolved only
          gte(channelDiagnosticsTable.fetchedAt, cutoff),   // fetched in last 48h
        ),
      );

    if (allDiags.length === 0) return [];

    const priceInvalid = allDiags.filter((d) =>
      d.issueType.toLowerCase().includes("price"),
    ).length;

    const invalidPct = (priceInvalid / allDiags.length) * 100;

    if (invalidPct > thresholdPct) {
      return [
        {
          type: "price_invalidity",
          severity: "warning",
          message: `Price invalidity ${invalidPct.toFixed(1)}% exceeds threshold ${thresholdPct}%`,
          details: { priceInvalid, total: allDiags.length, invalidPct, thresholdPct },
        },
      ];
    }
  } catch {
    // channel_diagnostics may not be populated yet — silent fail
  }
  return [];
}

/**
 * Check if Meta feed is stale (no current snapshot within policy window).
 */
async function checkMetaFeedStaleness(staleHours: number): Promise<Alert[]> {
  const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1_000);

  const [latest] = await db
    .select({ generatedAt: feedSnapshotsTable.generatedAt })
    .from(feedSnapshotsTable)
    .where(
      and(
        eq(feedSnapshotsTable.channel, "meta"),
        eq(feedSnapshotsTable.isCurrent, true),
      ),
    )
    .orderBy(desc(feedSnapshotsTable.generatedAt))
    .limit(1);

  if (!latest) {
    return [
      {
        type: "meta_feed_never_generated",
        severity: "warning",
        message: "Meta feed has never been generated",
      },
    ];
  }

  if (latest.generatedAt < cutoff) {
    const ageH = (Date.now() - latest.generatedAt.getTime()) / 3_600_000;
    return [
      {
        type: "meta_feed_stale",
        severity: "warning",
        message: `Meta feed is stale (${ageH.toFixed(1)}h old, threshold: ${staleHours}h)`,
        details: { generatedAt: latest.generatedAt.toISOString(), ageHours: ageH, thresholdHours: staleHours },
      },
    ];
  }
  return [];
}

/**
 * Check if stock data is stale (no inventory sync within policy window).
 */
async function checkStockStaleness(staleHours: number): Promise<Alert[]> {
  const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1_000);

  const [latest] = await db
    .select({ finishedAt: syncRunsTable.finishedAt, status: syncRunsTable.status })
    .from(syncRunsTable)
    .where(
      and(
        inArray(syncRunsTable.runType, ["inventory", "full"]),
        eq(syncRunsTable.status, "completed"),
      ),
    )
    .orderBy(desc(syncRunsTable.startedAt))
    .limit(1);

  if (!latest?.finishedAt) {
    return [
      {
        type: "stock_never_refreshed",
        severity: "warning",
        message: "Stock/inventory has never been refreshed",
      },
    ];
  }

  if (latest.finishedAt < cutoff) {
    const ageH = (Date.now() - latest.finishedAt.getTime()) / 3_600_000;
    return [
      {
        type: "stock_stale",
        severity: "warning",
        message: `Stock data is stale (${ageH.toFixed(1)}h old, threshold: ${staleHours}h)`,
        details: { finishedAt: latest.finishedAt.toISOString(), ageHours: ageH, thresholdHours: staleHours },
      },
    ];
  }
  return [];
}

/**
 * Check for critical Merchant Center diagnostics (disapproved / severely-limited).
 *
 * Only considers CURRENT diagnostics: unresolved rows (resolvedAt IS NULL)
 * fetched within the last 48 hours. This ensures the alert clears after the
 * diagnostics importer fetches a clean state from Google and marks old rows
 * as resolved, preventing permanent false-positives from historical data.
 */
async function checkMerchantDiagnostics(): Promise<Alert[]> {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1_000);

    const critical = await db
      .select({ count: count() })
      .from(channelDiagnosticsTable)
      .where(
        and(
          eq(channelDiagnosticsTable.channel, "google"),
          inArray(channelDiagnosticsTable.severity, ["disapproved", "critical"]),
          isNull(channelDiagnosticsTable.resolvedAt),        // unresolved only
          gte(channelDiagnosticsTable.fetchedAt, cutoff),   // fetched in last 48h
        ),
      );

    const critCount = Number(critical[0]?.count ?? 0);
    if (critCount > 0) {
      return [
        {
          type: "merchant_diagnostics_critical",
          severity: "critical",
          message: `${critCount} current unresolved critical Merchant Center issue(s) — products may be disapproved`,
          details: { criticalCount: critCount },
        },
      ];
    }
  } catch {
    // Diagnostics table might not have been populated yet
  }
  return [];
}

/**
 * Pure logic for translation coverage alert computation.
 *
 * Exported for unit testing — the DB-backed wrapper is `checkTranslationCoverage()`.
 *
 * @param total        - Number of active products (denominator)
 * @param locales      - Configured non-primary locales to check
 * @param countMap     - Translated active-product count per language code
 */
export function computeTranslationCoverageAlerts(
  total: number,
  locales: Array<{ code: string; name: string }>,
  countMap: Map<string, number>,
): Alert[] {
  if (total === 0) return [];

  const alerts: Alert[] = [];
  for (const lang of locales) {
    const translated = countMap.get(lang.code) ?? 0;
    if (translated >= total) continue; // 100% coverage — no alert

    const pct = Math.round((translated / total) * 100);
    if (translated === 0) {
      alerts.push({
        type: "translation_missing",
        severity: "warning",
        message:
          `Language '${lang.code}' (${lang.name}) has 0 translations — ` +
          (lang.code === "de"
            ? "publish the DE locale in Shopify admin → Settings → Languages, then run a full sync"
            : "configure this locale in Shopify admin and run a full sync"),
        details: { language: lang.code, translated: 0, total, coveragePct: 0 },
      });
    } else {
      alerts.push({
        type: "translation_partial",
        severity: "warning",
        message:
          `Language '${lang.code}' (${lang.name}) has partial translations — ` +
          `${translated.toLocaleString()} of ${total.toLocaleString()} products translated (${pct}%). ` +
          `${total - translated} products will fall back to the primary locale in feeds.`,
        details: { language: lang.code, translated, total, coveragePct: pct },
      });
    }
  }

  return alerts;
}

/**
 * Check that all configured non-primary locales have translations for all active products.
 *
 * Fires a "warning" alert when any non-primary locale (e.g. de, en, it) is missing
 * translations for one or more active products so that operators know German-market
 * feeds are falling back to the French primary locale rather than serving native content.
 *
 * Numerator and denominator are both scoped to active products — translations belonging
 * only to inactive/deleted products do not inflate coverage.
 */
async function checkTranslationCoverage(): Promise<Alert[]> {
  let config;
  try {
    config = loadConfig();
  } catch {
    return [];
  }

  const PRIMARY_LOCALE = "fr";
  const nonPrimary = config.languages.languages.filter((l) => l.code !== PRIMARY_LOCALE);
  if (nonPrimary.length === 0) return [];

  // Active product count — denominator for all non-primary locales
  const [activeRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(productsTable)
    .where(eq(productsTable.status, "active"));

  const total = activeRow?.total ?? 0;
  if (total === 0) return [];

  // Count distinct ACTIVE products with a complete translation (non-empty title).
  // syncLocale writes title="" when no title translation exists — only rows with a real
  // title are counted, matching the feed export's content requirement.
  // Join to productsTable so inactive/deleted product translations don't inflate the count.
  const rows = await db
    .select({
      language: productTranslationsTable.language,
      translated: sql<number>`count(distinct ${productTranslationsTable.productId})::int`,
    })
    .from(productTranslationsTable)
    .innerJoin(
      productsTable,
      and(
        eq(productsTable.id, productTranslationsTable.productId),
        eq(productsTable.status, "active"),
      ),
    )
    .where(ne(productTranslationsTable.title, ""))
    .groupBy(productTranslationsTable.language);

  const countMap = new Map(rows.map((r) => [r.language, r.translated]));
  return computeTranslationCoverageAlerts(total, nonPrimary, countMap);
}

// ── Exported individual checks (for testing and targeted use) ─────────────────

/**
 * Exported so tests can exercise diagnostic DB queries in isolation.
 */
export {
  checkMerchantDiagnostics as _checkMerchantDiagnostics,
  checkPriceInvalidity as _checkPriceInvalidity,
  checkFullSyncFailure as _checkFullSyncFailure,
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run all alert checks and return active alerts.
 * Also logs them to sync_errors and posts to webhook if configured.
 */
export async function checkAlerts(syncRunId: string | null = null): Promise<Alert[]> {
  let config;
  try {
    config = loadConfig();
  } catch {
    logger.warn("Could not load config for alert checks — using defaults");
    config = null;
  }

  const policy = config?.feedPolicy.alerts ?? {
    item_count_drop_threshold_pct: 5,
    price_invalid_threshold_pct: 2,
    meta_feed_stale_hours: 6,
    stock_stale_hours: 3,
  };

  const allAlerts: Alert[] = [];

  const checks = await Promise.allSettled([
    checkFullSyncFailure(),
    checkProductCountDrop(policy.item_count_drop_threshold_pct),
    checkPriceInvalidity(policy.price_invalid_threshold_pct),
    checkMetaFeedStaleness(policy.meta_feed_stale_hours),
    checkStockStaleness(policy.stock_stale_hours),
    checkMerchantDiagnostics(),
    checkTranslationCoverage(),
  ]);

  for (const result of checks) {
    if (result.status === "fulfilled") {
      allAlerts.push(...result.value);
    } else {
      logger.warn({ err: result.reason }, "Alert check failed");
    }
  }

  if (allAlerts.length > 0) {
    logger.warn({ alertCount: allAlerts.length, alerts: allAlerts.map((a) => a.type) }, "Active alerts detected");
    await logAlertsToDb(allAlerts, syncRunId).catch((err) =>
      logger.error({ err }, "Failed to log alerts to DB"),
    );
    await postWebhook(allAlerts).catch((err) =>
      logger.error({ err }, "Failed to post alerts to webhook"),
    );
  } else {
    logger.debug("No alerts detected");
  }

  return allAlerts;
}

/**
 * Evaluate the current alert conditions and return any that are active NOW.
 *
 * This function is called by feed-health to reflect the current system state.
 * It runs the same condition checks as checkAlerts() but WITHOUT logging to
 * the DB or firing webhooks — it is read-only and idempotent.
 *
 * Unlike a historical query, this always reflects the current DB state, so
 * alerts clear as soon as the underlying issue is resolved.
 */
export async function getActiveAlerts(): Promise<Alert[]> {
  const defaultPolicy = {
    item_count_drop_threshold_pct: 5,
    price_invalid_threshold_pct: 2,
    meta_feed_stale_hours: 6,
    stock_stale_hours: 3,
  };

  let config;
  try {
    config = loadConfig();
  } catch {
    config = null;
  }

  const policy = config?.feedPolicy.alerts ?? defaultPolicy;

  const checks = await Promise.allSettled([
    checkFullSyncFailure(),
    checkProductCountDrop(policy.item_count_drop_threshold_pct),
    checkPriceInvalidity(policy.price_invalid_threshold_pct),
    checkMetaFeedStaleness(policy.meta_feed_stale_hours),
    checkStockStaleness(policy.stock_stale_hours),
    checkMerchantDiagnostics(),
    checkTranslationCoverage(),
  ]);

  const activeAlerts: Alert[] = [];
  for (const result of checks) {
    if (result.status === "fulfilled") {
      activeAlerts.push(...result.value);
    } else {
      logger.warn({ err: result.reason }, "getActiveAlerts: condition check failed");
    }
  }
  return activeAlerts;
}
