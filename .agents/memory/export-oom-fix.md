---
name: Export OOM Fix
description: Root cause and fix for all "orphaned" sync runs caused by OOM during feed export
---

## The problem

All full syncs were crashing with "orphaned: process restarted while run was in progress".
Root cause: OOM during the Meta/Google export phase (not during Shopify sync phases).

**Meta export (old)**: loaded ALL canonicals into `canonicals[]` array (191k market_variants × 5–15KB each = 1–3GB), then built 7 CSV strings concurrently via `Promise.all`.

**Google export (old)**: accumulated all 5 markets' `GoogleFeedRow[]` simultaneously in `byMarket` Map, then iterated. 191k rows × ~3KB = 570MB just for rows, plus raw data Maps (~200MB).

**Local inventory**: kept `Map<string, Map<string, CanonicalProduct>>` for BE markets — ~76k full canonicals = 760MB alone.

**feed_items upserts**: 450k sequential `await db.insert()` calls (one per canonical) — slow and memory-intensive.

## The fix

### canonical-reader.ts — `processAllCanonicals(config, options, onCanonical)`
- Same bulk DB load as `readAllCanonicals` (one pass for all entity types)
- Processes ONE canonical at a time via async callback — no `canonicals[]` array
- Batches feed_items DB upserts 100 at a time (vs 1 per canonical) → 100× fewer round-trips
- Only passes ELIGIBLE canonicals (exclusionReasons empty) to callback

### meta/generator.ts
- Uses `processAllCanonicals` → accumulates only compact map rows (200–300 bytes each vs 5–15KB full canonicals)
- Peak memory: ~200MB (raw Maps) + ~30MB (row Maps) = ~230MB total
- Changed `Promise.all([7 publishFeed])` → sequential `for...of` — only 1 CSV string at a time

### google/runner.ts — market-by-market processing
- Processes ONE market at a time: `processAllCanonicals(markets: [marketCode])` in a loop
- Builds/uploads/publishes TSV, then `rows[]` goes out of scope → GC can reclaim
- Peak per market: ~200MB (raw Maps) + ~60MB (rows) = ~260MB vs 800MB+ before
- Trade-off: DB bulk queries run 5× (once per market) instead of once — acceptable overhead

### local-inventory.ts — `submitLocalInventoryEntries(entries)`
- New function accepting pre-built `LocalInventoryEntry[]` instead of full canonicals
- Google runner builds entries in streaming callback (tiny struct: variantId, quantity, etc.)
- `beInventoryByKey: Map<string, LocalInventoryEntry>` replaces `Map<string, Map<string, CanonicalProduct>>`

## Verified
- BE_FR test: 26,994 canonicals streamed in 78s, no OOM, feed uploaded to App Storage
- TypeScript clean
- Production Node.js heap limit: 4.2GB (16GB physical RAM available)

## Why: dry-run mode
Both Google and Meta default to dry-run (`GOOGLE_DRY_RUN !== 'false'`, `META_DRY_RUN !== 'false'`).
Set `GOOGLE_DRY_RUN=false` and `META_DRY_RUN=false` as env vars to actually publish current pointers.
Versioned files ARE uploaded in dry-run mode — just not copied to current path.

## Data scale (as of this session)
- 2,089 active products
- 38,363 variants
- 191,815 market_variants (5 markets)
- 41,033 images
- 55,426 inventory_levels
- 4,814 translations (fr: 2,718 / en: 2,096 / de: 0)
