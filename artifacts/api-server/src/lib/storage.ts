/**
 * Feed Storage — server-side wrapper around Replit App Storage (GCS-backed).
 *
 * Used exclusively for server-generated feed files (TSV/CSV snapshots, manifests).
 * NOT for presigned client uploads — for that see the object-storage skill.
 *
 * Storage layout:
 *   feeds/google/google-{language}-{market}.tsv          current snapshot
 *   feeds/google/google-{language}-{market}.manifest.json
 *   feeds/google/versions/{ts}/google-{language}-{market}.tsv  versioned
 *   feeds/meta/meta-base.csv                             current snapshot
 *   feeds/meta/meta-language-fr.csv
 *   feeds/meta/meta-language-de.csv
 *   feeds/meta/meta-country-{CC}.csv
 *   feeds/meta/versions/{ts}/...                         versioned
 */

import { Storage } from "@google-cloud/storage";
import { createHash } from "crypto";
import { logger as rootLogger } from "./logger";
import { sendFeedBlockAlert, resolveAlertWebhookUrl } from "./alerting";

const logger = rootLogger.child({ module: "feed-storage" });

// ── GCS client (Replit sidecar auth) ─────────────────────────────────────────

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const storageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
} as ConstructorParameters<typeof Storage>[0]);

function getBucket() {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set — run setupObjectStorage()");
  return storageClient.bucket(bucketId);
}

// ── Feed manifest ─────────────────────────────────────────────────────────────

export interface FeedManifest {
  version: string; // ISO timestamp
  generatedAt: string; // ISO timestamp
  itemCount: number;
  sha256: string;
  sourceRunId: string | null;
  channel: string;
  language: string | null;
  marketCode: string | null;
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Upload a feed file to App Storage.
 * Returns the sha256 hash of the content.
 */
export async function uploadFeedFile(
  storagePath: string,
  content: string | Buffer,
  contentType: "text/csv" | "text/tab-separated-values" | "application/json",
): Promise<string> {
  const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  const sha256 = createHash("sha256").update(buf).digest("hex");

  const file = getBucket().file(storagePath);
  await file.save(buf, {
    contentType,
    metadata: { sha256 },
    resumable: false,
  });

  logger.debug({ storagePath, bytes: buf.length, sha256 }, "Feed file uploaded");
  return sha256;
}

/**
 * Download a feed file from App Storage.
 * Returns null if the file does not exist.
 */
export async function downloadFeedFile(storagePath: string): Promise<Buffer | null> {
  const file = getBucket().file(storagePath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [content] = await file.download();
  return content;
}

/**
 * Check if a feed file exists in App Storage.
 */
export async function feedFileExists(storagePath: string): Promise<boolean> {
  const [exists] = await getBucket().file(storagePath).exists();
  return exists;
}

/**
 * List feed files under a prefix.
 */
export async function listFeedFiles(prefix: string): Promise<string[]> {
  const [files] = await getBucket().getFiles({ prefix });
  return files.map((f) => f.name);
}

/**
 * Upload a feed manifest alongside the feed file.
 */
export async function uploadManifest(
  feedPath: string,
  manifest: FeedManifest,
): Promise<void> {
  const manifestPath = `${feedPath}.manifest.json`;
  await uploadFeedFile(manifestPath, JSON.stringify(manifest, null, 2), "application/json");
}

/**
 * Download the manifest for a feed file. Returns null if not found.
 */
export async function downloadManifest(feedPath: string): Promise<FeedManifest | null> {
  const manifestPath = `${feedPath}.manifest.json`;
  const buf = await downloadFeedFile(manifestPath);
  if (!buf) return null;
  return JSON.parse(buf.toString("utf-8")) as FeedManifest;
}

// ── Atomic publish ─────────────────────────────────────────────────────────────

/**
 * Atomic feed publish gate.
 *
 * Strategy:
 * 1. Content already written to `versionedPath` by the generator.
 * 2. This function validates the content meets the gate criteria.
 * 3. If OK, atomically copies to `currentPath` (overwrites the previous current).
 * 4. If failed, retains the previous `currentPath` and logs an alert.
 *
 * Returns true if published, false if gate failed (old snapshot retained).
 */
export async function atomicPublish(params: {
  versionedPath: string;
  currentPath: string;
  manifest: FeedManifest;
  previousItemCount: number | null;
  maxDropPct: number;
  /** Resolved webhook URL (env var takes priority over config). Pass null to skip alerting. */
  alertWebhookUrl?: string | null;
}): Promise<boolean> {
  const { versionedPath, currentPath, manifest, previousItemCount, maxDropPct } = params;
  const alertWebhookUrl = params.alertWebhookUrl ?? resolveAlertWebhookUrl();

  // Gate: item count must not drop by more than maxDropPct vs previous snapshot
  if (previousItemCount !== null && previousItemCount > 0) {
    const dropPct = ((previousItemCount - manifest.itemCount) / previousItemCount) * 100;
    if (dropPct > maxDropPct) {
      logger.error(
        {
          currentPath,
          previousItemCount,
          newItemCount: manifest.itemCount,
          dropPct: dropPct.toFixed(1),
          maxDropPct,
        },
        "Feed publish BLOCKED: item count drop exceeds threshold — retaining previous snapshot",
      );

      // Fire webhook alert (non-blocking — errors are swallowed inside sendFeedBlockAlert)
      await sendFeedBlockAlert(
        {
          channel: manifest.channel,
          marketOrFile: manifest.marketCode ?? manifest.language ?? currentPath,
          previousItemCount,
          newItemCount: manifest.itemCount,
          dropPct,
          reason: "item_count_drop",
          syncRunId: manifest.sourceRunId,
        },
        alertWebhookUrl,
      );

      return false;
    }
  }

  // Copy versioned → current (overwrites)
  const bucket = getBucket();
  await bucket.file(versionedPath).copy(bucket.file(currentPath));
  await bucket.file(`${versionedPath}.manifest.json`).copy(bucket.file(`${currentPath}.manifest.json`));

  logger.info(
    { currentPath, itemCount: manifest.itemCount, sha256: manifest.sha256 },
    "Feed published atomically",
  );
  return true;
}

// ── Path helpers ───────────────────────────────────────────────────────────────

export function googleFeedPath(language: string, marketCode: string): string {
  return `feeds/google/google-${language}-${marketCode}.tsv`;
}

export function metaFeedPath(suffix: string): string {
  return `feeds/meta/${suffix}`;
}

export function versionedPath(basePath: string, versionTs: string): string {
  // feeds/google/google-fr-BE_FR.tsv → feeds/google/versions/2024-01-01T120000/google-fr-BE_FR.tsv
  const parts = basePath.split("/");
  const filename = parts.pop()!;
  return [...parts, "versions", versionTs, filename].join("/");
}

export function formatVersionTs(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
