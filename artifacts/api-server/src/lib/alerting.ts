/**
 * Feed alerting — webhook notifications for blocked publishes.
 *
 * Supports Slack Incoming Webhooks and Microsoft Teams webhook cards.
 * The payload format is auto-detected from the webhook URL:
 *   - Teams URLs contain "webhook.office.com" or "office.com/webhook"
 *   - Everything else is treated as Slack.
 *
 * The webhook URL is resolved (in order of priority):
 *   1. ALERT_WEBHOOK_URL environment variable
 *   2. alerts.webhook_url key in config/feed-policy.yaml
 *
 * If no URL is configured the function logs a warning and returns — this is
 * intentional: alerting is optional and must never crash the export pipeline.
 */

import { logger as rootLogger } from "./logger";

const logger = rootLogger.child({ module: "feed-alerting" });

export interface FeedBlockAlertPayload {
  /** "google" | "meta" */
  channel: string;
  /** e.g. "BE_FR", "country-BE", "base", "language-fr" */
  marketOrFile: string;
  /** null when no previous snapshot exists */
  previousItemCount: number | null;
  newItemCount: number;
  /** null when the block was caused by schema errors, not a count drop */
  dropPct: number | null;
  /** Reason for the block */
  reason: "item_count_drop" | "schema_error";
  syncRunId: string | null;
}

// ── Webhook URL resolution ─────────────────────────────────────────────────────

/**
 * Returns the effective webhook URL, preferring the env var over the config
 * value. Returns null when neither is set.
 */
export function resolveAlertWebhookUrl(configUrl?: string): string | null {
  const envUrl = process.env["ALERT_WEBHOOK_URL"];
  if (envUrl?.trim()) return envUrl.trim();
  if (configUrl?.trim()) return configUrl.trim();
  return null;
}

// ── Payload builders ───────────────────────────────────────────────────────────

function isTeamsWebhook(url: string): boolean {
  return url.includes("webhook.office.com") || url.includes("office.com/webhook");
}

function buildSlackPayload(alert: FeedBlockAlertPayload): object {
  const icon = ":rotating_light:";
  const dropLine =
    alert.dropPct !== null
      ? `*Drop:* ${alert.dropPct.toFixed(1)}% (prev ${alert.previousItemCount?.toLocaleString() ?? "?"}  →  new ${alert.newItemCount.toLocaleString()})`
      : `*New count:* ${alert.newItemCount.toLocaleString()}`;

  const reasonLabel =
    alert.reason === "item_count_drop"
      ? "Item count drop exceeded threshold"
      : "Feed schema validation failed";

  return {
    text: `${icon} *Feed publish BLOCKED — ${alert.channel.toUpperCase()}*`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `${icon} *Feed publish BLOCKED* — live catalog NOT updated`,
            `*Channel:* ${alert.channel.toUpperCase()}`,
            `*Feed / Market:* \`${alert.marketOrFile}\``,
            `*Reason:* ${reasonLabel}`,
            dropLine,
            alert.syncRunId ? `*Sync run:* \`${alert.syncRunId}\`` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Previous live snapshot retained. Review the sync run logs to investigate.`,
          },
        ],
      },
    ],
  };
}

function buildTeamsPayload(alert: FeedBlockAlertPayload): object {
  const reasonLabel =
    alert.reason === "item_count_drop"
      ? "Item count drop exceeded threshold"
      : "Feed schema validation failed";

  const facts = [
    { name: "Channel", value: alert.channel.toUpperCase() },
    { name: "Feed / Market", value: alert.marketOrFile },
    { name: "Reason", value: reasonLabel },
    {
      name: "Item count",
      value:
        alert.dropPct !== null
          ? `${alert.previousItemCount?.toLocaleString() ?? "?"} → ${alert.newItemCount.toLocaleString()} (−${alert.dropPct.toFixed(1)}%)`
          : String(alert.newItemCount.toLocaleString()),
    },
  ];

  if (alert.syncRunId) {
    facts.push({ name: "Sync run", value: alert.syncRunId });
  }

  return {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor: "FF0000",
    summary: `Feed publish BLOCKED — ${alert.channel.toUpperCase()} ${alert.marketOrFile}`,
    sections: [
      {
        activityTitle: `🚨 Feed publish BLOCKED — ${alert.channel.toUpperCase()}`,
        activitySubtitle: "Live catalog NOT updated — previous snapshot retained.",
        facts,
      },
    ],
  };
}

// ── Sender ─────────────────────────────────────────────────────────────────────

/**
 * Fire a webhook alert for a blocked feed publish.
 *
 * Never throws — errors are logged but do not propagate so the export
 * pipeline is never interrupted by a webhook failure.
 */
export async function sendFeedBlockAlert(
  alert: FeedBlockAlertPayload,
  webhookUrl: string | null,
): Promise<void> {
  if (!webhookUrl) {
    logger.warn(
      {
        channel: alert.channel,
        marketOrFile: alert.marketOrFile,
        reason: alert.reason,
      },
      "Feed publish blocked but no ALERT_WEBHOOK_URL configured — alert not sent",
    );
    return;
  }

  const payload = isTeamsWebhook(webhookUrl)
    ? buildTeamsPayload(alert)
    : buildSlackPayload(alert);

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000), // 10-second cap — never block export
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status, channel: alert.channel, marketOrFile: alert.marketOrFile },
        "Alert webhook returned non-OK status",
      );
    } else {
      logger.info(
        { channel: alert.channel, marketOrFile: alert.marketOrFile, reason: alert.reason },
        "Feed block alert sent via webhook",
      );
    }
  } catch (err) {
    logger.warn(
      { err, channel: alert.channel, marketOrFile: alert.marketOrFile },
      "Failed to send feed block alert webhook",
    );
  }
}
