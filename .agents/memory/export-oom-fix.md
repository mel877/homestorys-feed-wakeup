---
name: Export OOM Fix
description: Root cause and fix for all "orphaned" sync runs caused by OOM during feed export
---

## The problem

All full syncs were crashing with "orphaned: process restarted while run was in progress".
Root cause: OOM during the Meta export phase (Google was already fixed market-by-market).

**Meta export (second-gen, still OOMing)**: called `processAllCanonicals` once per market (5× total),
loading 29k variants + 35k images + 55k inventory each time. V8 does not GC old-generation objects
between async iterations, so 5× worth of bulk data (≈ 5–8 GB) accumulated simultaneously.

OOM manifested at different stages across attempts:
- All-markets-at-once: OOM at ~4 GB during streaming
- Per-market loop (processAllCanonicals × 5): OOM at ~8 GB after streaming, during CSV generation
- Bulk-load-once + accumulator maps (all 3 alive): OOM at ~8 GB during/after AT market processing
  because langFrRows + langDeRows + baseRows ≈ 135k + 54k + 81k = 270k rows × 5–10 KB = 8 GB

## The fix (in meta/generator.ts)

### 1. One-time bulk loading
Load products, variants, marketVariants, images, inventory, recommendations ONCE before the market
loop. Build lookup Maps once. This eliminates the 5× repeated DB query / V8-no-GC problem.

### 2. Inline country file publishing
After each market is processed, check if all markets for that country are done. If so, publish the
country CSV immediately and `pendingCountryRows.delete(country)` to free those rows.

### 3. Inline language file publishing
Same pattern for language files: publish `language-fr` right after FR (last French market), publish
`language-de` right after AT (last German market). This halves the peak accumulator size.

Peak at any point: bulk data (~1 GB) + baseRows (~750 MB) + one language group (≤ 300 MB) + one
country buffer (≤ 30 MB) ≈ 2–3 GB — well under the 12 GB limit.

### 4. Explicit array clearing after market loop
After the loop, both Map.clear() AND `arr.splice(0)` on the raw DB result arrays. V8 GC only
collects objects when all references are gone; the `const` binding kept the arrays alive even after
Map.clear(). splice(0) removes array elements so row objects become GC-eligible.

### 5. Streamed base CSV (2026-08-17)
The base file was the last big accumulator: 134k MetaBaseRow objects in a Map, serialized all at
once. Since dedup only needs the ids and first occurrence wins, base rows are now streamed
row-by-row through a `csv-stringify` Transform into a GCS write stream
(`createFeedFileWriteStream` in lib/storage.ts) during the market loop; only a `Set<string>` of
seen ids stays in memory. Gate/manifest/DB logic runs afterward via `finalizeFeed` on the
already-uploaded versioned file. Heap limit reduced back to `--max-old-space-size=4096`.
Peak heap ≈ bulk data + one language group + one country buffer, well under 4 GB.
Rule: never rebuild a rows array for the base file — any new base-layer logic must stream.

## Verified (2026-08-14)
- All 7 Meta CSV files generated in a single run (no OOM):
  - meta-base.csv: 134,973 rows
  - meta-language-fr.csv: 53,988 rows
  - meta-language-de.csv: 80,985 rows
  - meta-country-BE.csv: 53,989 rows, meta-country-FR.csv: 26,994, meta-country-DE.csv: 26,995, meta-country-AT.csv: 26,995
- Duration: ~12 minutes, dryRun=true (versioned paths; META_DRY_RUN=false needed for live publish)
- Server remained alive throughout; no crash

## Google export
Already fixed market-by-market (one processAllCanonicals per market). Peak: ~260 MB.
5 TSV files confirmed uploaded in a prior run of this session.

## Dry-run mode
Both Google and Meta default to dry-run:
- `GOOGLE_DRY_RUN !== 'false'` → dry run
- `META_DRY_RUN !== 'false'` → dry run
Versioned files ARE uploaded in dry-run. Set both env vars to 'false' to update current pointers.

## Data scale (2026-08-14)
- 2,089 active products, 29,574 variants, 147,870 market_variants (5 markets)
- 35,012 images, inventory & recommendations loaded similarly
