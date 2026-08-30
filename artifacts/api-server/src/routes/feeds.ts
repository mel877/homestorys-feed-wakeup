/**
 * Feed serving routes.
 *
 * GET /feeds/meta/:file         — serve current Meta CSV files from App Storage
 * GET /feeds/meta/lang/:lang    — serve a language override CSV
 * GET /feeds/meta/country/:cc   — serve a country override CSV
 * GET /feeds/google/debug/:file — serve a Google TSV snapshot (internal debug)
 *
 * Meta feeds are public (no auth) — Meta fetches them on a schedule.
 * Google debug route is internal-only (requires X-Internal-Secret header).
 *
 * Spec reference: §1366-1379 (URL patterns), §1329-1362 (Meta architecture).
 */

import { Router, type Request, type Response } from "express";
import {
  compressedFeedPath,
  getFeedFileMetadata,
  googleFeedPath,
  openFeedFileReadStream,
  type FeedFileMetadata,
} from "../lib/storage";
import { logger as rootLogger } from "../lib/logger";
import { loadConfig } from "../config";
import { requireInternalAuth } from "../middlewares/internal-auth";
import { requireDashboardAuth } from "./dashboard/auth";
import { db, feedSnapshotsTable } from "@workspace/db";
import { ListFeedSnapshotsQueryParams } from "@workspace/api-zod";
import { eq, desc, sql, and } from "drizzle-orm";

const logger = rootLogger.child({ module: "feed-routes" });

const router = Router();
const MAX_ADVERTISED_CONTENT_LENGTH = 32 * 1024 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setFeedHeaders(
  res: Response,
  contentType: string,
  rawSize: number | null,
  representation?: { compressed: boolean; size: number | null },
): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", "inline");
  if (rawSize !== null) res.setHeader("X-Feed-Size", rawSize);

  const transferSize = representation?.size ?? rawSize;
  if (representation?.compressed) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    if (transferSize !== null) {
      res.setHeader("X-Feed-Compressed-Size", transferSize);
    }
  }
  if (transferSize !== null && transferSize <= MAX_ADVERTISED_CONTENT_LENGTH) {
    res.setHeader("Content-Length", transferSize);
  }
}

async function selectFeedRepresentation(
  storagePath: string,
): Promise<{
  storagePath: string;
  metadata: FeedFileMetadata;
  rawSize: number | null;
  compressed: boolean;
} | null> {
  const metadata = await getFeedFileMetadata(storagePath);
  if (!metadata) return null;
  if (metadata.size === null || metadata.size <= MAX_ADVERTISED_CONTENT_LENGTH) {
    return { storagePath, metadata, rawSize: metadata.size, compressed: false };
  }

  const gzipPath = compressedFeedPath(storagePath);
  const gzipMetadata = await getFeedFileMetadata(gzipPath);
  if (!gzipMetadata) {
    throw Object.assign(
      new Error(`Compressed derivative missing for large feed: ${storagePath}`),
      { code: "COMPRESSED_FEED_MISSING" },
    );
  }
  return {
    storagePath: gzipPath,
    metadata: gzipMetadata,
    rawSize: metadata.size,
    compressed: true,
  };
}

async function serveFeedFile(
  storagePath: string,
  contentType: string,
  req: Request,
  res: Response,
  cacheControl = "public, max-age=300",
  context: {
    channel: "google" | "meta" | "showroom";
    language?: string;
    market?: string;
    generationMode?: "stable" | "snapshot";
  },
): Promise<void> {
  const publishedStoragePath = await resolvePublishedStoragePath(storagePath, context);
  if (!publishedStoragePath) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "60");
    res.status(503).json({ error: "Feed temporarily unavailable" });
    return;
  }
  storagePath = publishedStoragePath;
  const startedAt = Date.now();
  const requestId = String(req.id ?? req.headers["x-request-id"] ?? "");
  if (requestId) res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", cacheControl);
  const logResult = (
    statusCode: number,
    extra: { bytes?: number | null; errorType?: string } = {},
  ) => {
    logger.info(
      {
        requestId: requestId || undefined,
        method: req.method,
        channel: context.channel,
        language: context.language,
        market: context.market,
        generationMode: context.generationMode ?? "stable",
        statusCode,
        durationMs: Date.now() - startedAt,
        bytes: extra.bytes,
        errorType: extra.errorType,
      },
      "Feed request completed",
    );
  };
  let clientDisconnected = res.destroyed || res.req.aborted;
  const handleDisconnectWhileOpening = () => {
    clientDisconnected = true;
  };
  res.once("close", handleDisconnectWhileOpening);

  if (req.method === "HEAD") {
    try {
      const representation = await selectFeedRepresentation(storagePath);
      res.off("close", handleDisconnectWhileOpening);
      if (clientDisconnected || res.destroyed) return;
      if (!representation) {
        res.status(404).json({ error: "Feed file not found" });
        logResult(404, { errorType: "file_not_found" });
        return;
      }
      setFeedHeaders(res, contentType, representation.rawSize, {
        compressed: representation.compressed,
        size: representation.metadata.size,
      });
      res.status(200).end();
      logResult(200, { bytes: representation.rawSize });
    } catch {
      res.off("close", handleDisconnectWhileOpening);
      if (clientDisconnected || res.destroyed) return;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "60");
      res.status(503).json({ error: "Feed temporarily unavailable" });
      logResult(503, { errorType: "storage_metadata_failed" });
    }
    return;
  }

  let feedFile;
  let representation;
  try {
    representation = await selectFeedRepresentation(storagePath);
    feedFile = representation
      ? await openFeedFileReadStream(
          representation.storagePath,
          representation.metadata,
        )
      : null;
  } catch (error) {
    res.off("close", handleDisconnectWhileOpening);
    if (clientDisconnected || res.destroyed) {
      logger.info({ requestId: requestId || undefined }, "Client disconnected while feed file was opening");
      return;
    }
    logger.error(
      {
        requestId: requestId || undefined,
        channel: context.channel,
        errorType:
          error instanceof Error && "code" in error && error.code === "COMPRESSED_FEED_MISSING"
            ? "compressed_derivative_missing"
            : "storage_open_failed",
      },
      "Failed to open feed file from App Storage",
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "60");
    res.status(503).json({ error: "Feed temporarily unavailable" });
    logResult(503, { errorType: "storage_open_failed" });
    return;
  }

  if (!feedFile) {
    res.off("close", handleDisconnectWhileOpening);
    if (clientDisconnected || res.destroyed) return;
    res.status(404).json({ error: "Feed file not found" });
    logResult(404, { errorType: "file_not_found" });
    return;
  }

  if (clientDisconnected || res.destroyed) {
    feedFile.stream.once("error", (error) => {
      logger.info({ err: error, storagePath }, "Feed stream errored while cancelling open");
    });
    feedFile.stream.destroy();
    res.off("close", handleDisconnectWhileOpening);
    logger.info({ requestId: requestId || undefined }, "Feed stream cancelled after client disconnected while opening");
    return;
  }

  // The published Google Frontend rejects large dynamically-served bodies
  // when their full Content-Length is announced. Keep small files explicit,
  // but let large feeds use progressive/chunked transfer.
  setFeedHeaders(res, contentType, representation?.rawSize ?? feedFile.size, {
    compressed: representation?.compressed ?? false,
    size: feedFile.size,
  });

  await new Promise<void>((resolve) => {
    let settled = false;

    const cleanupResponse = () => {
      res.off("error", handleResponseError);
      res.off("finish", handleFinish);
      res.off("close", handleClientDisconnect);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanupResponse();
      resolve();
    };
    const handleSourceError = (error: Error) => {
      if (settled) {
        logger.info({ err: error, storagePath }, "Feed stream errored while closing");
        return;
      }
      feedFile.stream.unpipe(res);
      logger.error(
        { requestId: requestId || undefined, channel: context.channel, errorType: "storage_stream_failed" },
        "Feed stream failed",
      );

      if (!res.headersSent && !res.destroyed) {
        res.removeHeader("Content-Length");
        res.removeHeader("Content-Type");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Retry-After", "60");
        res.status(503).json({ error: "Feed temporarily unavailable" });
        logResult(503, { errorType: "storage_stream_failed" });
      } else if (!res.destroyed) {
        res.destroy();
      }
      settle();
    };
    const handleSourceClose = () => {
      feedFile.stream.off("error", handleSourceError);
    };
    const handleResponseError = (error: Error) => {
      feedFile.stream.destroy();
      logger.info({ err: error, storagePath }, "Feed stream stopped after response error");
      settle();
    };
    const handleFinish = () => {
      logResult(res.statusCode, { bytes: feedFile.size });
      settle();
    };
    const handleClientDisconnect = () => {
      if (!res.writableEnded) {
        feedFile.stream.destroy();
        logger.info({ storagePath }, "Feed stream stopped after client disconnected");
      }
      settle();
    };

    feedFile.stream.once("error", handleSourceError);
    feedFile.stream.once("close", handleSourceClose);
    res.once("error", handleResponseError);
    res.once("finish", handleFinish);
    res.once("close", handleClientDisconnect);
    res.off("close", handleDisconnectWhileOpening);

    if (clientDisconnected || res.destroyed) {
      handleClientDisconnect();
    } else {
      feedFile.stream.pipe(res);
    }
  });
}

function resolveSnapshotMarketCode(
  fallbackPath: string,
  context: {
    channel: "google" | "meta" | "showroom";
    language?: string;
    market?: string;
  },
): string | undefined {
  if (
    context.channel === "meta" &&
    context.language &&
    fallbackPath.includes("/meta-language-")
  ) {
    return `META_LANGUAGE_${context.language.toUpperCase()}`;
  }
  if (context.market) return context.market;
  if (context.language) return `LANG_${context.language.toUpperCase()}`;
  if (context.channel !== "meta") return undefined;
  if (fallbackPath.endsWith("/meta-base.csv")) return "BASE";
  const country = fallbackPath.match(/meta-country-([A-Z]{2})\.csv$/);
  const language = fallbackPath.match(/meta-(?:language-)?([a-z]{2})\.csv$/);
  return country?.[1] ?? (
    language?.[1] ? `LANG_${language[1].toUpperCase()}` : undefined
  );
}

async function resolvePublishedStoragePath(
  fallbackPath: string,
  context: {
    channel: "google" | "meta" | "showroom";
    language?: string;
    market?: string;
  },
): Promise<string | null> {
  if (context.channel === "showroom") return fallbackPath;
  const marketCode = resolveSnapshotMarketCode(fallbackPath, context);
  if (!marketCode) return fallbackPath;
  try {
    const [snapshot] = await db
      .select({ storagePath: feedSnapshotsTable.storagePath })
      .from(feedSnapshotsTable)
      .where(and(
        eq(feedSnapshotsTable.channel, context.channel),
        eq(feedSnapshotsTable.marketCode, marketCode),
        eq(feedSnapshotsTable.isCurrent, true),
      ))
      .orderBy(desc(feedSnapshotsTable.generatedAt))
      .limit(1);
    return snapshot?.storagePath ?? (
      context.channel === "meta" ? null : fallbackPath
    );
  } catch {
    logger.warn(
      { channel: context.channel, marketCode },
      "Snapshot pointer lookup failed; using legacy current path",
    );
    return context.channel === "meta" ? null : fallbackPath;
  }
}

export const feedRouteTestHooks = process.env.NODE_ENV === "test"
  ? { resolveSnapshotMarketCode }
  : null;

// ── Meta feed routes ──────────────────────────────────────────────────────────

/** Stable flat catalog URLs for Meta. */
router.get("/feeds/meta/fr.csv", async (_req: Request, res: Response) => {
  await serveFeedFile("feeds/meta/meta-fr.csv", "text/csv; charset=utf-8", _req, res, undefined, { channel: "meta", language: "fr" });
});
router.get("/feeds/meta/de.csv", async (_req: Request, res: Response) => {
  await serveFeedFile("feeds/meta/meta-de.csv", "text/csv; charset=utf-8", _req, res, undefined, { channel: "meta", language: "de" });
});

/** GET /feeds/meta/base.csv */
router.get("/feeds/meta/base.csv", async (_req: Request, res: Response) => {
  await serveFeedFile("feeds/meta/meta-base.csv", "text/csv; charset=utf-8", _req, res, undefined, { channel: "meta" });
});

/** GET /feeds/meta/lang/:lang — e.g. /feeds/meta/lang/fr.csv */
router.get("/feeds/meta/lang/:lang", async (req: Request, res: Response) => {
  const rawLang = req.params["lang"];
  const lang = (Array.isArray(rawLang) ? rawLang[0] : rawLang)?.replace(/\.csv$/, "");
  if (!lang || !/^[a-z]{2}$/.test(lang)) {
    res.status(400).json({ error: "Invalid language code" });
    return;
  }
  await serveFeedFile(
    `feeds/meta/meta-language-${lang}.csv`,
    "text/csv; charset=utf-8",
    req,
    res,
    undefined,
    { channel: "meta", language: lang },
  );
});

/** GET /feeds/meta/country/:cc — e.g. /feeds/meta/country/BE.csv */
router.get("/feeds/meta/country/:cc", async (req: Request, res: Response) => {
  const rawCc = req.params["cc"];
  const cc = (Array.isArray(rawCc) ? rawCc[0] : rawCc)?.replace(/\.csv$/, "").toUpperCase();
  if (!cc || !/^[A-Z]{2}$/.test(cc)) {
    res.status(400).json({ error: "Invalid country code" });
    return;
  }
  await serveFeedFile(
    `feeds/meta/meta-country-${cc}.csv`,
    "text/csv; charset=utf-8",
    req,
    res,
    undefined,
    { channel: "meta", market: cc },
  );
});

/**
 * GET /feeds/meta/:file — generic Meta feed file fallback.
 * Supports: base.csv, meta-base.csv, meta-language-fr.csv, etc.
 */
router.get("/feeds/meta/:file", async (req: Request, res: Response) => {
  const rawFile = req.params["file"];
  const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;
  if (!file || !/^[\w.-]+\.csv$/.test(file)) {
    res.status(400).json({ error: "Invalid feed filename" });
    return;
  }

  // Normalise: strip leading "meta-" if provided directly in path
  const storageName = file.startsWith("meta-") ? file : `meta-${file}`;
  await serveFeedFile(`feeds/meta/${storageName}`, "text/csv; charset=utf-8", req, res, undefined, { channel: "meta" });
});

// ── Google feed routes (public — for GMC file-fetch) ─────────────────────────

/** Stable language URLs for Google Merchant Center. */
router.get("/feeds/google/fr.tsv", async (_req: Request, res: Response) => {
  await serveFeedFile("feeds/google/google-fr.tsv", "text/tab-separated-values; charset=utf-8", _req, res, undefined, { channel: "google", language: "fr" });
});
router.get("/feeds/google/de.tsv", async (_req: Request, res: Response) => {
  await serveFeedFile("feeds/google/google-de.tsv", "text/tab-separated-values; charset=utf-8", _req, res, undefined, { channel: "google", language: "de" });
});

/**
 * GET /feeds/google/market/:market.tsv
 *
 * Public, no auth. Google Merchant Center fetches this URL on a schedule.
 * Returns the current published TSV for the given market (e.g. AT, BE_FR, DE).
 * Resolves the actual storage path from the feed_snapshots table so the public
 * URL is stable even if internal storage paths change.
 */
router.get("/feeds/google/market/:market", async (req: Request, res: Response): Promise<void> => {
  const raw = req.params["market"];
  const market = (Array.isArray(raw) ? raw[0] : raw)?.replace(/\.tsv$/, "").toUpperCase();
  if (!market || !/^[A-Z0-9_]{2,10}$/.test(market)) {
    res.status(400).json({ error: "Invalid market code" });
    return;
  }

  const config = loadConfig();
  const configuredMarket = config.markets.markets[market];
  if (!configuredMarket) {
    res.status(404).json({ error: "Unknown Google market", market });
    return;
  }

  let snapshotStoragePath: string | undefined;
  try {
    const snapshot = await db
      .select({ storagePath: feedSnapshotsTable.storagePath })
      .from(feedSnapshotsTable)
      .where(
        and(
          eq(feedSnapshotsTable.channel, "google"),
          eq(feedSnapshotsTable.marketCode, market),
          eq(feedSnapshotsTable.isCurrent, true),
        ),
      )
      .limit(1);
    snapshotStoragePath = snapshot[0]?.storagePath;
  } catch {
    logger.warn(
      { requestId: String(req.id ?? ""), channel: "google", market, errorType: "snapshot_lookup_failed" },
      "Google snapshot lookup failed; using deterministic current path",
    );
  }

  // Current Google objects have deterministic paths and are replaced only
  // after validation. Falling back to that path keeps the last valid object
  // available when snapshot metadata is missing or its database is unavailable.
  const storagePath = snapshotStoragePath
    ?? googleFeedPath(configuredMarket.language, market);
  await serveFeedFile(storagePath, "text/tab-separated-values; charset=utf-8", req, res, undefined, { channel: "google", market, generationMode: "snapshot" });
});

// ── Showroom feed routes (public — for GMC and Meta file-fetch) ──────────────

/**
 * GET /feeds/google/showroom/eupen.tsv
 *
 * Public, no auth. Google Merchant Center fetches this URL for the Eupen
 * showroom campaign. Contains only products with stockEupen > 0.
 */
router.get("/feeds/google/showroom/eupen.tsv", async (_req: Request, res: Response) => {
  await serveFeedFile(
    "feeds/showroom/google-eupen.tsv",
    "text/tab-separated-values; charset=utf-8",
    _req,
    res,
    undefined,
    { channel: "showroom", language: "de", market: "EUPEN" },
  );
});

/**
 * GET /feeds/meta/showroom/eupen.csv
 *
 * Public, no auth. Meta Commerce Manager fetches this URL for the Eupen
 * showroom catalog. Flat CSV (no layered structure).
 */
router.get("/feeds/meta/showroom/eupen.csv", async (_req: Request, res: Response) => {
  await serveFeedFile(
    "feeds/showroom/meta-eupen.csv",
    "text/csv; charset=utf-8",
    _req,
    res,
    undefined,
    { channel: "showroom", language: "de", market: "EUPEN_META" },
  );
});

/**
 * GET /feeds/showroom/:file — generic showroom file handler.
 * Used by dashboard download links (generated by the feed_snapshots route).
 * e.g. /feeds/showroom/google-eupen.tsv, /feeds/showroom/meta-eupen.csv
 */
router.get("/feeds/showroom/:file", async (req: Request, res: Response) => {
  const rawFile = req.params["file"];
  const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;
  if (!file || !/^[\w.-]+\.(tsv|csv)$/.test(file)) {
    res.status(400).json({ error: "Invalid showroom feed filename" });
    return;
  }
  const isTsv = file.endsWith(".tsv");
  await serveFeedFile(
    `feeds/showroom/${file}`,
    isTsv ? "text/tab-separated-values; charset=utf-8" : "text/csv; charset=utf-8",
    req,
    res,
    undefined,
    { channel: "showroom" },
  );
});

// ── Google debug routes (internal-only) ───────────────────────────────────────

/**
 * GET /feeds/google/debug/:file — serve a Google TSV for debugging.
 * Protected by internal API secret.
 * e.g. /feeds/google/debug/google-fr-BE_FR.tsv
 */
router.get(
  "/feeds/google/debug/:file",
  requireInternalAuth,
  async (req: Request, res: Response) => {
    const rawFile = req.params["file"];
    const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    if (!file || !/^[\w.-]+\.tsv$/.test(file)) {
      res.status(400).json({ error: "Invalid feed filename" });
      return;
    }
    await serveFeedFile(
      `feeds/google/${file}`,
      "text/tab-separated-values; charset=utf-8",
      req,
      res,
      undefined,
      { channel: "google", generationMode: "snapshot" },
    );
  },
);

// ── Dashboard: Google feed download (auth-gated) ──────────────────────────────

/**
 * GET /feeds/google/dashboard/:file — serve a Google TSV snapshot for dashboard users.
 * Uses the same session cookie auth as the rest of the dashboard.
 * Separated from the internal-secret route to avoid leaking the internal key.
 */
router.get(
  "/feeds/google/dashboard/:file",
  requireDashboardAuth,
  async (req: Request, res: Response): Promise<void> => {
    const rawFile = req.params["file"];
    const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    if (!file || !/^[\w.-]+\.tsv$/.test(file)) {
      res.status(400).json({ error: "Invalid feed filename" });
      return;
    }
    await serveFeedFile(
      `feeds/google/${file}`,
      "text/tab-separated-values; charset=utf-8",
      req,
      res,
      "private, no-store",
      { channel: "google", generationMode: "snapshot" },
    );
  },
);

// ── Dashboard: feed snapshots list ────────────────────────────────────────────

/**
 * GET /feeds/snapshots — list feed snapshots for the dashboard.
 * Secured with dashboard session cookie.
 */
router.get("/feeds/snapshots", requireDashboardAuth, async (req: Request, res: Response): Promise<void> => {
  const params = ListFeedSnapshotsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { channel, currentOnly } = params.data;

  const conditions = [];
  if (channel) conditions.push(eq(feedSnapshotsTable.channel, channel));
  if (currentOnly) conditions.push(eq(feedSnapshotsTable.isCurrent, true));

  const rows = await db.select().from(feedSnapshotsTable)
    .where(conditions.length ? sql`${conditions.reduce((a, b) => sql`${a} and ${b}`)}` : undefined)
    .orderBy(desc(feedSnapshotsTable.generatedAt))
    .limit(200);

  const items = rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    language: r.language ?? null,
    marketCode: r.marketCode ?? null,
    storagePath: r.storagePath,
    itemCount: r.itemCount ?? 0,
    sha256: r.sha256 ?? null,
    isCurrent: r.isCurrent ?? false,
    generatedAt: r.generatedAt?.toISOString() ?? "",
    downloadUrl: r.storagePath
      ? r.channel === "google"
        ? `/api/feeds/google/dashboard/${r.storagePath.split("/").pop() ?? ""}`
        : `/api/feeds/${r.channel}/${r.storagePath.split("/").pop() ?? ""}`
      : null,
  }));

  res.json(items);
});

export default router;
