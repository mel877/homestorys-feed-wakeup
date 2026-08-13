/**
 * Transparent image classification test.
 *
 * Uses a real sharp-generated transparent PNG buffer (no mocks) to verify
 * that computeAlphaRatio correctly measures the alpha channel and the
 * classifier returns "packshot_transparent" for images with > 15% transparency.
 *
 * This test catches the regression where computeAlphaRatio passed a raw pixel
 * buffer to a new sharp() instance without raw metadata, causing sharp to throw
 * (swallowed by try/catch) and return alphaRatio = 0.
 */

import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { classifyImageBuffer } from "../src/images/classifier";

/**
 * Build a minimal 400×400 RGBA PNG where exactly half of the pixels are
 * fully transparent (alpha=0) and the other half are opaque white (alpha=255).
 *
 * Transparent pixel fraction = 0.5 → well above the 0.15 threshold.
 * We build from a raw RGBA buffer so the alpha values are exact.
 */
async function makePartiallyTransparentPng(): Promise<Buffer> {
  const w = 400;
  const h = 400;
  const raw = Buffer.alloc(w * h * 4);

  // Top half: opaque white (alpha=255)
  // Bottom half: fully transparent (alpha=0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      raw[idx] = 255;     // R
      raw[idx + 1] = 255; // G
      raw[idx + 2] = 255; // B
      raw[idx + 3] = y < h / 2 ? 255 : 0; // alpha: opaque top, transparent bottom
    }
  }

  return sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Build a fully opaque 400×400 white PNG (no alpha channel).
 */
async function makeOpaquePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
}

/**
 * Build a fully transparent 400×400 PNG.
 * Alpha fraction = 1.0 → well above 0.15 threshold.
 */
async function makeFullyTransparentPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 400,
      height: 400,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
}

describe("Transparent image classification (real sharp, no mocks)", () => {
  it("classifies a partially transparent PNG as packshot_transparent", async () => {
    const buffer = await makePartiallyTransparentPng();
    const result = await classifyImageBuffer(buffer, sharp);

    // Alpha ratio must be > 0 (the bug returned 0 due to raw-buffer/sharp issue)
    expect(result.alphaRatio).toBeGreaterThan(0);
    // Transparent fraction ≈ 25% — well above the 15% threshold
    expect(result.alphaRatio).toBeGreaterThan(0.15);
    expect(result.imageType).toBe("packshot_transparent");
  });

  it("classifies a fully transparent PNG as packshot_transparent", async () => {
    const buffer = await makeFullyTransparentPng();
    const result = await classifyImageBuffer(buffer, sharp);

    expect(result.alphaRatio).toBeGreaterThan(0.9);
    expect(result.imageType).toBe("packshot_transparent");
  });

  it("classifies a fully opaque PNG as NOT packshot_transparent", async () => {
    const buffer = await makeOpaquePng();
    const result = await classifyImageBuffer(buffer, sharp);

    // Opaque image has no alpha channel → alpha ratio = 0
    expect(result.alphaRatio).toBe(0);
    expect(result.imageType).not.toBe("packshot_transparent");
  });

  it("alpha ratio is between 0 and 1 for a partially transparent image", async () => {
    const buffer = await makePartiallyTransparentPng();
    const result = await classifyImageBuffer(buffer, sharp);

    expect(result.alphaRatio).toBeGreaterThan(0);
    expect(result.alphaRatio).toBeLessThanOrEqual(1);
  });
});
