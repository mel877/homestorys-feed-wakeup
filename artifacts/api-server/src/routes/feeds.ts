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

export default router;
