---
name: Sharp alpha ratio pipeline
description: How to correctly compute per-pixel alpha ratio with sharp — must NOT create a new sharp() from a raw pixel buffer without metadata.
---

## Rule
When computing the alpha ratio (fraction of transparent pixels) in sharp, **stay in the same pipeline**. Do not call `sharpFn(rawBuffer)` without raw width/height/channels metadata — sharp cannot decode a plain pixel dump and will throw (swallowed by try/catch), returning alphaRatio = 0.

```ts
// CORRECT: one pipeline, no new sharp() instance
const { data, info } = await img
  .resize(sampleW, sampleH)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const channels = info.channels; // 4 after ensureAlpha
for (let i = channels - 1; i < data.length; i += channels) {
  if (data[i] < 128) transparent++;
}

// WRONG: passes raw bytes to new sharp() → sharp cannot decode → throws
const bad = await sharpFn(await img.resize(...).raw().toBuffer())
  .ensureAlpha().raw().toBuffer();
```

**Why:** A raw pixel buffer (`Buffer` of RGBA bytes) is NOT a valid image file. Sharp's constructor accepts image files or `{raw:{width,height,channels}}` options — not a bare buffer. Without those options it throws a decode error, which is silently caught, leaving alphaRatio at 0 and misclassifying all transparent packshots.

**How to apply:** Any time you need per-pixel data, compose the entire operation as a single sharp pipeline. If you need to branch (e.g. clone for different analyses), clone the sharp instance, not the raw buffer.
