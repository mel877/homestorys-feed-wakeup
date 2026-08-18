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

import { Router, type Request, type Response, type NextFunction } from "express";
import { downloadFeedFile } from "../lib/storage";
import { logger as rootLogger } from "../lib/logger";
import { requireInternalAuth } from "../middlewares/internal-auth";
import { requireDashboardAuth } from "./dashboard/auth";
import { db, feedSnapshotsTable } from "@workspace/db";
import { ListFeedSnapshotsQueryParams } from "@workspace/api-zod";
import { eq, desc, sql, and } from "drizzle-orm";

const logger = rootLogger.child({ module: "feed-routes" });

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function serveFeedFile(
  storagePath: string,
  contentType: string,
  res: Response,
): Promise<void> {
  const buf = await downloadFeedFile(storagePath);
  if (!buf) {
    res.status(404).json({ error: "Feed file not found", storagePath });
    return;
  }
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", buf.length);
  res.setHeader("Cache-Control", "public, max-age=300"); // 5-min cache for Meta crawlers
  res.send(buf);
}

// ── Meta feed routes ──────────────────────────────────────────────────────────

/** GET /feeds/meta/base.csv */
router.get("/feeds/meta/base.csv", async (_req: Request, res: Response) => {
  await serveFeedFile("feeds/meta/meta-base.csv", "text/csv; charset=utf-8", res);
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
    res,
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
    res,
  );
});

/**
 * GET /feeds/meta/:file — generic Meta feed file fallback.
 * Supports: base.csv, meta-base.csv, meta-language-fr.csv, etc.
 */
router.get("/feeds/meta/:file", async (req: Request, res: Response) => {
  const rawFile = req.params["file"];
  const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;
  if (!file || !/^[\w\-\.]+\.csv$/.test(file)) {
    res.status(400).json({ error: "Invalid feed filename" });
    return;
  }

  // Normalise: strip leading "meta-" if provided directly in path
  const storageName = file.startsWith("meta-") ? file : `meta-${file}`;
  await serveFeedFile(`feeds/meta/${storageName}`, "text/csv; charset=utf-8", res);
});

// ── Google feed routes (public — for GMC file-fetch) ─────────────────────────

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
  if (!snapshot[0]) {
    res.status(404).json({ error: "No current Google feed for this market. Run an export first.", market });
    return;
  }
  await serveFeedFile(snapshot[0].storagePath, "text/tab-separated-values; charset=utf-8", res);
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
    res,
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
    res,
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
  if (!file || !/^[\w\-\.]+\.(tsv|csv)$/.test(file)) {
    res.status(400).json({ error: "Invalid showroom feed filename" });
    return;
  }
  const isTsv = file.endsWith(".tsv");
  await serveFeedFile(
    `feeds/showroom/${file}`,
    isTsv ? "text/tab-separated-values; charset=utf-8" : "text/csv; charset=utf-8",
    res,
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
    if (!file || !/^[\w\-\.]+\.tsv$/.test(file)) {
      res.status(400).json({ error: "Invalid feed filename" });
      return;
    }
    await serveFeedFile(
      `feeds/google/${file}`,
      "text/tab-separated-values; charset=utf-8",
      res,
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
    if (!file || !/^[\w\-\.]+\.tsv$/.test(file)) {
      res.status(400).json({ error: "Invalid feed filename" });
      return;
    }
    // Authenticated endpoint — must not be cached by shared proxies or CDNs.
    // Do NOT reuse serveFeedFile() which sets Cache-Control: public.
    const buf = await downloadFeedFile(`feeds/google/${file}`);
    if (!buf) {
      res.status(404).json({ error: "Feed file not found", storagePath: `feeds/google/${file}` });
      return;
    }
    res.setHeader("Content-Type", "text/tab-separated-values; charset=utf-8");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(buf);
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
