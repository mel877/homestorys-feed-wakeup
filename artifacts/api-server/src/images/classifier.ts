/**
 * Image classifier — spec section 19.
 *
 * Uses `sharp` for deterministic, pixel-level image analysis.
 * Classifies each image into one of 7 types:
 *   lifestyle | packshot_white | packshot_solid | packshot_transparent | detail | invalid | unknown
 *
 * Classifications are based on:
 * - White background score: % of corner pixels near-white (R,G,B > 245)
 * - Solid background score: low variance in corner region
 * - Alpha ratio: fraction of transparent pixels (PNG only)
 * - Edge density: Sobel-like edge pixel fraction
 * - Variance: overall pixel variance (high = complex scene)
 * - Resolution score: meets minimum resolution requirements
 * - Aspect ratio: width/height
 */

import type { ImageType } from "../canonical/types";
import { logger as rootLogger } from "../lib/logger";

const logger = rootLogger.child({ module: "image-classifier" });

export interface ImageMetrics {
  width: number;
  height: number;
  aspectRatio: number;
  alphaRatio: number; // 0-1, fraction of transparent pixels
  whiteBgScore: number; // 0-1, fraction of near-white corner pixels
  solidBgScore: number; // 0-1, how uniform the corners are (regardless of colour)
  edgeDensity: number; // 0-1, fraction of edge pixels
  variance: number; // 0-65025, pixel variance (stddev²)
  resolutionScore: number; // 0-1, meets quality threshold
}

export interface ClassificationResult extends ImageMetrics {
  imageType: ImageType;
  classificationReason: string;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const MIN_WIDTH = 400;
const MIN_HEIGHT = 400;
const MIN_RESOLUTION_SCORE = 0.3;
const IDEAL_MIN_DIMENSION = 800;

// White pixel threshold: R,G,B all > this value
const WHITE_THRESHOLD = 235;

// Variance threshold: below this = very uniform = probably solid bg
const SOLID_BG_VARIANCE_THRESHOLD = 200;

// White score thresholds
const WHITE_BG_SCORE_THRESHOLD = 0.75; // > 75% of corners near white
const SOLID_BG_SCORE_THRESHOLD = 0.70;
const ALPHA_RATIO_THRESHOLD = 0.15; // > 15% transparent = packshot_transparent

// Scene complexity: high variance + edge density = lifestyle
const LIFESTYLE_VARIANCE_THRESHOLD = 1500;
const LIFESTYLE_EDGE_DENSITY_THRESHOLD = 0.05;

// ── Main classifier ───────────────────────────────────────────────────────────

/**
 * Download and classify an image from URL.
 * Returns null if the image can't be fetched/processed.
 * This function makes a real HTTP request — mock it in tests.
 */
export async function classifyImageUrl(url: string): Promise<ClassificationResult | null> {
  // Dynamic import so tests can mock sharp without bundling issues
  const sharp = (await import("sharp")).default;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      logger.warn({ url, status: response.status }, "Image fetch failed");
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return classifyImageBuffer(buffer, sharp);
  } catch (err) {
    logger.warn({ url, err }, "Image classification failed");
    return null;
  }
}

/**
 * Classify an image from a Buffer.
 * Separated from URL fetching for testability.
 */
export async function classifyImageBuffer(
  buffer: Buffer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharpFn: any,
): Promise<ClassificationResult> {
  const img = sharpFn(buffer);
  const metadata = await img.metadata();

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const hasAlpha = metadata.hasAlpha ?? false;

  // ── Resolution check ──────────────────────────────────────────────────────
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return makeResult(
      { width, height, aspectRatio: safeRatio(width, height), alphaRatio: 0, whiteBgScore: 0, solidBgScore: 0, edgeDensity: 0, variance: 0, resolutionScore: 0 },
      "invalid",
      `Resolution too low: ${width}×${height}`,
    );
  }

  const resolutionScore = Math.min(
    1,
    Math.min(width, height) / IDEAL_MIN_DIMENSION,
  );

  // ── Extract corner patch for background analysis ──────────────────────────
  const cornerSize = Math.max(20, Math.floor(Math.min(width, height) * 0.1));

  // Analyse all four corners
  const corners = await Promise.all([
    sampleRegion(img.clone(), { left: 0, top: 0, width: cornerSize, height: cornerSize }),
    sampleRegion(img.clone(), { left: width - cornerSize, top: 0, width: cornerSize, height: cornerSize }),
    sampleRegion(img.clone(), { left: 0, top: height - cornerSize, width: cornerSize, height: cornerSize }),
    sampleRegion(img.clone(), { left: width - cornerSize, top: height - cornerSize, width: cornerSize, height: cornerSize }),
  ]);

  const whiteBgScore = computeWhiteScore(corners);
  const solidBgScore = computeSolidScore(corners);

  // ── Alpha / transparency analysis ─────────────────────────────────────────
  let alphaRatio = 0;
  if (hasAlpha) {
    alphaRatio = await computeAlphaRatio(img.clone(), sharpFn);
  }

  // ── Edge density (sample centre 50% of image) ─────────────────────────────
  const edgeDensity = await computeEdgeDensity(img.clone());

  // ── Overall variance ──────────────────────────────────────────────────────
  const variance = await computeVariance(img.clone());

  const metrics: ImageMetrics = {
    width,
    height,
    aspectRatio: safeRatio(width, height),
    alphaRatio,
    whiteBgScore,
    solidBgScore,
    edgeDensity,
    variance,
    resolutionScore,
  };

  // ── Classification logic ──────────────────────────────────────────────────
  const imageType = classifyMetrics(metrics);
  const reason = explainClassification(imageType, metrics);

  return makeResult(metrics, imageType, reason);
}

/** Pure classification from metrics (testable without sharp). */
export function classifyMetrics(m: ImageMetrics): ImageType {
  // Invalid: too small (already checked above, but also check ratio)
  if (m.resolutionScore < MIN_RESOLUTION_SCORE) return "invalid";

  // Transparent packshot: alpha > threshold
  if (m.alphaRatio >= ALPHA_RATIO_THRESHOLD) return "packshot_transparent";

  // White background packshot
  if (m.whiteBgScore >= WHITE_BG_SCORE_THRESHOLD) return "packshot_white";

  // Solid background packshot (non-white uniform background)
  if (m.solidBgScore >= SOLID_BG_SCORE_THRESHOLD && m.whiteBgScore < WHITE_BG_SCORE_THRESHOLD) {
    return "packshot_solid";
  }

  // Lifestyle: high complexity + edges (scene/context image)
  if (m.variance >= LIFESTYLE_VARIANCE_THRESHOLD && m.edgeDensity >= LIFESTYLE_EDGE_DENSITY_THRESHOLD) {
    return "lifestyle";
  }

  // Detail: high edge density but lower variance (tight crop of product)
  if (m.edgeDensity >= 0.12 && m.variance < LIFESTYLE_VARIANCE_THRESHOLD) {
    return "detail";
  }

  return "unknown";
}

function explainClassification(type: ImageType, m: ImageMetrics): string {
  switch (type) {
    case "invalid": return `Resolution score ${m.resolutionScore.toFixed(2)} below threshold`;
    case "packshot_transparent": return `Alpha ratio ${m.alphaRatio.toFixed(2)} >= ${ALPHA_RATIO_THRESHOLD}`;
    case "packshot_white": return `White bg score ${m.whiteBgScore.toFixed(2)} >= ${WHITE_BG_SCORE_THRESHOLD}`;
    case "packshot_solid": return `Solid bg score ${m.solidBgScore.toFixed(2)} >= ${SOLID_BG_SCORE_THRESHOLD}`;
    case "lifestyle": return `Variance ${m.variance.toFixed(0)}, edge density ${m.edgeDensity.toFixed(3)}`;
    case "detail": return `Edge density ${m.edgeDensity.toFixed(3)}, variance ${m.variance.toFixed(0)}`;
    default: return "No classification criteria met";
  }
}

// ── Region sampling helpers ───────────────────────────────────────────────────

interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CornerSample {
  r: number; g: number; b: number; variance: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sampleRegion(img: any, region: Region): Promise<CornerSample> {
  const { data } = await img
    .extract(region)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = data.length / 3;
  let sumR = 0, sumG = 0, sumB = 0;

  for (let i = 0; i < data.length; i += 3) {
    sumR += data[i];
    sumG += data[i + 1];
    sumB += data[i + 2];
  }

  const avgR = sumR / pixels;
  const avgG = sumG / pixels;
  const avgB = sumB / pixels;

  // Variance within this corner (pixel distance from mean colour)
  let varSum = 0;
  for (let i = 0; i < data.length; i += 3) {
    const dr = data[i] - avgR;
    const dg = data[i + 1] - avgG;
    const db = data[i + 2] - avgB;
    varSum += (dr * dr + dg * dg + db * db) / 3;
  }

  return { r: avgR, g: avgG, b: avgB, variance: varSum / pixels };
}

function computeWhiteScore(corners: CornerSample[]): number {
  const whiteCorners = corners.filter(
    (c) => c.r >= WHITE_THRESHOLD && c.g >= WHITE_THRESHOLD && c.b >= WHITE_THRESHOLD,
  );
  return whiteCorners.length / corners.length;
}

function computeSolidScore(corners: CornerSample[]): number {
  // "Solid" = corners have very low internal variance AND agree with each other
  const internallyUniform = corners.filter((c) => c.variance < SOLID_BG_VARIANCE_THRESHOLD);
  if (internallyUniform.length < 2) return 0;

  // Check if corners share a similar colour
  const avgR = internallyUniform.reduce((s, c) => s + c.r, 0) / internallyUniform.length;
  const avgG = internallyUniform.reduce((s, c) => s + c.g, 0) / internallyUniform.length;
  const avgB = internallyUniform.reduce((s, c) => s + c.b, 0) / internallyUniform.length;

  const cohesion = internallyUniform.filter(
    (c) =>
      Math.abs(c.r - avgR) < 30 &&
      Math.abs(c.g - avgG) < 30 &&
      Math.abs(c.b - avgB) < 30,
  );

  return cohesion.length / corners.length;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeAlphaRatio(img: any, _sharpFn: any): Promise<number> {
  try {
    const metadata = await img.metadata();
    const w = metadata.width ?? 100;
    const h = metadata.height ?? 100;
    const sampleW = Math.min(w, 200);
    const sampleH = Math.min(h, 200);

    // Resize + ensureAlpha in one pipeline — do NOT pass the raw buffer to a new
    // sharp() instance (sharp cannot decode a raw pixel buffer without explicit
    // {raw: {width,height,channels}} metadata and would throw or return 0 alpha).
    const { data, info } = await img
      .resize(sampleW, sampleH)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let transparent = 0;
    const total = info.width * info.height;
    const channels = info.channels as number; // 4 after ensureAlpha
    for (let i = channels - 1; i < data.length; i += channels) {
      if (data[i] < 128) transparent++;
    }
    return total > 0 ? transparent / total : 0;
  } catch {
    return 0;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeEdgeDensity(img: any): Promise<number> {
  try {
    // Use sharp's Sobel/Laplacian via convolve or just estimate with variance of greyscale
    const { data, info } = await img
      .greyscale()
      .resize(100, 100)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;
    let edgePixels = 0;
    const total = (w - 2) * (h - 2);

    // Simple horizontal/vertical gradient
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const gx = Math.abs(data[idx + 1] - data[idx - 1]);
        const gy = Math.abs(data[idx + w] - data[idx - w]);
        if (gx + gy > 30) edgePixels++;
      }
    }

    return edgePixels / total;
  } catch {
    return 0;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeVariance(img: any): Promise<number> {
  try {
    const stats = await img.greyscale().resize(100, 100).stats();
    return stats.channels[0]?.std ? stats.channels[0].std ** 2 : 0;
  } catch {
    return 0;
  }
}

// ── Result helpers ────────────────────────────────────────────────────────────

function makeResult(
  metrics: ImageMetrics,
  imageType: ImageType,
  classificationReason: string,
): ClassificationResult {
  return { ...metrics, imageType, classificationReason };
}

function safeRatio(w: number, h: number): number {
  if (h === 0) return 0;
  return Math.round((w / h) * 100) / 100;
}

// ── Image selection (priority ordering) ─────────────────────────────────────

export interface ClassifiedImage {
  url: string;
  urlHash: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  imageType: ImageType;
  position: number;
}

/**
 * Select primary and lifestyle images for Google channel.
 *
 * Google priority:
 * 1. Override (feed.primary_image_override)
 * 2. packshot_white (clearest product image)
 * 3. packshot_solid
 * 4. packshot_transparent
 * 5. lifestyle
 * 6. Any valid image
 */
export function selectGoogleImages(
  images: ClassifiedImage[],
  primaryOverrideUrl?: string | null,
  lifestyleOverrideUrl?: string | null,
): { primary: ClassifiedImage | null; lifestyle: ClassifiedImage | null; additional: ClassifiedImage[] } {
  const valid = images.filter((i) => i.imageType !== "invalid" && !isFabricImage(i));

  // Primary override
  let primary: ClassifiedImage | null = null;
  if (primaryOverrideUrl) {
    primary = valid.find((i) => i.url === primaryOverrideUrl) ?? null;
  }

  if (!primary) {
    primary =
      valid.find((i) => i.imageType === "packshot_white") ??
      valid.find((i) => i.imageType === "packshot_solid") ??
      valid.find((i) => i.imageType === "packshot_transparent") ??
      valid.find((i) => i.imageType === "detail") ??
      valid.find((i) => i.imageType === "lifestyle") ??
      valid[0] ??
      null;
  }

  // Lifestyle override
  let lifestyle: ClassifiedImage | null = null;
  if (lifestyleOverrideUrl) {
    lifestyle = valid.find((i) => i.url === lifestyleOverrideUrl) ?? null;
  }
  if (!lifestyle) {
    lifestyle = valid.find((i) => i.imageType === "lifestyle" && i !== primary) ?? null;
  }

  const additional = valid.filter((i) => i !== primary && i !== lifestyle);

  return { primary, lifestyle, additional };
}

// ── Fabric / swatch image guard ───────────────────────────────────────────────

/**
 * Returns true when an image is a fabric or material swatch — never a product
 * photo suitable for channel feeds.
 *
 * Detection strategy (any match → fabric):
 *   • URL contains fabric-related path segments or keywords.
 *   • Alt text matches the Shopify fabric-swatch naming convention used by
 *     manufacturers: "C{digits} · NAME" or "CF{digits} · NAME"
 *     (e.g. "C148 · TENDER EARTH", "CF171 · SOFT GREY").
 */
function isFabricImage(img: ClassifiedImage): boolean {
  const url = img.url.toLowerCase();
  const alt = img.altText ?? "";

  // URL-based signals
  if (
    url.includes("/fabric/") ||
    url.includes("fabric-") ||
    url.includes("-fabric") ||
    url.includes("_fabric") ||
    url.includes("/stof/") ||   // Dutch
    url.includes("/tissu/") ||  // French
    url.includes("/stoff/") ||  // German
    url.includes("swatch") ||
    url.includes("kleurstaal") ||
    url.includes("farbmuster")
  ) {
    return true;
  }

  // Alt text: swatch code pattern — "C148 · NAME", "CF171 · NAME", "C049-GRAPHITE", etc.
  if (/^CF?\d+[\s·\-–]/i.test(alt)) return true;

  return false;
}

/**
 * Select primary and lifestyle images for Meta channel.
 *
 * Meta priority:
 * 1. Override (feed.lifestyle_image_override)
 * 2. lifestyle (contextual scene)
 * 3. packshot (any)
 * 4. Exclude if no valid image
 */
export function selectMetaImages(
  images: ClassifiedImage[],
  primaryOverrideUrl?: string | null,
  lifestyleOverrideUrl?: string | null,
): { primary: ClassifiedImage | null; lifestyle: ClassifiedImage | null; additional: ClassifiedImage[] } {
  const valid = images.filter((i) => i.imageType !== "invalid" && !isFabricImage(i));

  let lifestyle: ClassifiedImage | null = null;
  if (lifestyleOverrideUrl) {
    lifestyle = valid.find((i) => i.url === lifestyleOverrideUrl) ?? null;
  }
  if (!lifestyle) {
    lifestyle = valid.find((i) => i.imageType === "lifestyle") ?? null;
  }

  let primary: ClassifiedImage | null = null;
  if (primaryOverrideUrl) {
    primary = valid.find((i) => i.url === primaryOverrideUrl) ?? null;
  }
  if (!primary) {
    // Meta prefers lifestyle as primary if available
    primary = lifestyle ?? valid.find((i) => i.imageType !== "invalid") ?? null;
  }

  // Avoid duplicating primary in lifestyle
  if (lifestyle === primary) {
    lifestyle = valid.find((i) => i !== primary && i.imageType === "lifestyle") ?? null;
  }

  const additional = valid.filter((i) => i !== primary && i !== lifestyle);

  return { primary, lifestyle, additional };
}
