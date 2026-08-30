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
import { Transform, type Readable } from "stream";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";
import { logger as rootLogger } from "./logger";
import { sendFeedBlockAlert, resolveAlertWebhookUrl } from "./alerting";

const logger = rootLogger.child({ module: "feed-storage" });
const LARGE_FEED_THRESHOLD_BYTES = 32 * 1024 * 1024;

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

export async function uploadImmutableFeedFile(
  storagePath: string,
  content: string | Buffer,
  contentType: "application/json",
): Promise<string> {
  const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const file = getBucket().file(storagePath);
  try {
    await file.save(buf, {
      contentType,
      metadata: { sha256 },
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    return sha256;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
    if (code !== 412 && code !== "412") throw error;
    const existingSha256 = await computeFeedFileSha256(storagePath);
    if (existingSha256 !== sha256) {
      throw new Error(`Immutable feed artifact already exists with different bytes: ${storagePath}`);
    }
    return sha256;
  }
}

/**
 * Create a write stream for uploading a feed file to App Storage incrementally.
 *
 * Used by large exports (Meta base CSV) to avoid materializing the whole file
 * in memory. Content piped into `stream` is hashed on the fly; await `done`
 * after ending the stream to get the sha256 and byte count.
 */
export function createFeedFileWriteStream(
  storagePath: string,
  contentType: "text/csv" | "text/tab-separated-values" | "application/json",
  options: { immutable?: boolean } = {},
): { stream: NodeJS.WritableStream; done: Promise<{ sha256: string; bytes: number }> } {
  const file = getBucket().file(storagePath);
  const hash = createHash("sha256");
  let bytes = 0;

  const gcsStream = file.createWriteStream({
    contentType,
    resumable: false,
    ...(options.immutable ? { preconditionOpts: { ifGenerationMatch: 0 } } : {}),
  });

  const hashingStream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  const done = new Promise<{ sha256: string; bytes: number }>((resolve, reject) => {
    gcsStream.on("finish", () => {
      const sha256 = hash.digest("hex");
      logger.debug({ storagePath, bytes, sha256 }, "Feed file uploaded (streamed)");
      resolve({ sha256, bytes });
    });
    gcsStream.on("error", reject);
    hashingStream.on("error", reject);
  });

  hashingStream.pipe(gcsStream);
  return { stream: hashingStream, done };
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
 * Recompute an object's SHA-256 from its immutable body stream.
 * Returns null when the object does not exist.
 */
export async function computeFeedFileSha256(
  storagePath: string,
): Promise<string | null> {
  const file = await openFeedFileReadStream(storagePath);
  if (!file) return null;
  const hash = createHash("sha256");
  for await (const chunk of file.stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export interface FeedFileReadStream {
  stream: Readable;
  size: number | null;
}

export interface FeedFileMetadata {
  size: number | null;
  generation: string | null;
  contentType: string | null;
  updatedAt: string | null;
}

function isStorageNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 404 || code === "404";
}

/**
 * Read feed object metadata without downloading its body.
 */
export async function getFeedFileMetadata(
  storagePath: string,
): Promise<FeedFileMetadata | null> {
  const file = getBucket().file(storagePath);

  try {
    const [metadata] = await file.getMetadata();
    const parsedSize = Number(metadata.size);
    return {
      size: Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : null,
      generation: metadata.generation ? String(metadata.generation) : null,
      contentType: metadata.contentType ? String(metadata.contentType) : null,
      updatedAt: metadata.updated ? String(metadata.updated) : null,
    };
  } catch (error) {
    if (isStorageNotFound(error)) return null;
    throw error;
  }
}

/**
 * Open a feed file for incremental download.
 *
 * Metadata is fetched before opening the body stream so routes can return a
 * proper 404/503 before committing response headers. The file body itself is
 * never materialized in server memory.
 */
export async function openFeedFileReadStream(
  storagePath: string,
  knownMetadata?: FeedFileMetadata,
): Promise<FeedFileReadStream | null> {
  const file = getBucket().file(storagePath);

  try {
    const metadata = knownMetadata ?? (await file.getMetadata())[0];
    const parsedSize = Number(metadata.size);
    const readFile = metadata.generation
      ? getBucket().file(storagePath, { generation: metadata.generation })
      : file;
    return {
      stream: storagePath.endsWith(".gz")
        ? readFile.createReadStream({ decompress: false })
        : readFile.createReadStream(),
      size: Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : null,
    };
  } catch (error) {
    if (isStorageNotFound(error)) return null;
    throw error;
  }
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

export async function uploadImmutableManifest(
  feedPath: string,
  manifest: FeedManifest,
): Promise<void> {
  await uploadImmutableFeedFile(
    `${feedPath}.manifest.json`,
    JSON.stringify(manifest, null, 2),
    "application/json",
  );
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

export async function createCompressedDerivativeIfLarge(
  storagePath: string,
): Promise<string | null> {
  const bucket = getBucket();
  const sourceFile = bucket.file(storagePath);
  const [metadata] = await sourceFile.getMetadata();
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size <= LARGE_FEED_THRESHOLD_BYTES) {
    return null;
  }

  const gzipPath = compressedFeedPath(storagePath);
  const pinnedSource = metadata.generation
    ? bucket.file(storagePath, { generation: metadata.generation })
    : sourceFile;
  const destination = bucket.file(gzipPath);
  const output = destination.createWriteStream({
    metadata: {
      contentEncoding: "gzip",
      contentType: metadata.contentType ?? "application/octet-stream",
      metadata: {
        sourceGeneration: metadata.generation ? String(metadata.generation) : "",
        sourceSize: String(size),
      },
    },
    resumable: false,
  });

  await pipeline(
    pinnedSource.createReadStream(),
    createGzip({ level: 6 }),
    output,
  );
  logger.info({ storagePath, gzipPath, sourceBytes: size }, "Large feed compressed");
  return gzipPath;
}

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

  if (!await passesFeedSnapshotGate({
    currentPath,
    manifest,
    previousItemCount,
    maxDropPct,
    alertWebhookUrl,
  })) return false;

  // Prepare the compressed representation before touching the current pointer.
  // A compression/storage error therefore retains the previous valid snapshot.
  const bucket = getBucket();
  const compressedVersioned = await createCompressedDerivativeIfLarge(versionedPath);
  if (compressedVersioned) {
    await bucket
      .file(compressedVersioned)
      .copy(bucket.file(compressedFeedPath(currentPath)));
  }

  // Copy versioned → current (overwrites)
  await bucket.file(versionedPath).copy(bucket.file(currentPath));
  await bucket.file(`${versionedPath}.manifest.json`).copy(bucket.file(`${currentPath}.manifest.json`));

  logger.info(
    { currentPath, itemCount: manifest.itemCount, sha256: manifest.sha256 },
    "Feed published atomically",
  );
  return true;
}

export async function passesFeedSnapshotGate(params: {
  currentPath: string;
  manifest: FeedManifest;
  previousItemCount: number | null;
  maxDropPct: number;
  alertWebhookUrl?: string | null;
}): Promise<boolean> {
  const { currentPath, manifest, previousItemCount, maxDropPct } = params;
  const alertWebhookUrl = params.alertWebhookUrl ?? resolveAlertWebhookUrl();
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
  return true;
}

// ── Path helpers ───────────────────────────────────────────────────────────────

export function googleFeedPath(language: string, marketCode: string): string {
  return `feeds/google/google-${language}-${marketCode}.tsv`;
}

/** Stable public language feed; overwritten atomically after every export. */
export function googleLanguageFeedPath(language: string): string {
  return `feeds/google/google-${language}.tsv`;
}

export function metaFeedPath(suffix: string): string {
  return `feeds/meta/${suffix}`;
}

export function metaMarketFeedPath(marketCode: string): string {
  return metaFeedPath(`meta-market-${marketCode}.csv`);
}

/** Stable public language feed; overwritten atomically after every export. */
export function metaLanguageFeedPath(language: string): string {
  return `feeds/meta/meta-${language}.csv`;
}

export function compressedFeedPath(feedPath: string): string {
  return `${feedPath}.gz`;
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
