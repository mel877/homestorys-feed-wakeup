---
name: Meta Export Heap Accumulation
description: Why repeated Meta exports in the same server process cause OOM, and how to avoid it
---

## The problem

Running `runMetaExport` more than once in the same long-lived server process causes heap to accumulate between runs. V8's old-generation objects (bulk DB arrays, lookup Maps) do not get collected between async export invocations even after `splice(0)` and `Map.clear()`. A second run sees heap starting at the first run's residual level, and by DE market processing can hit 4+ GB instead of the ~760 MB seen in a fresh process.

## Observed numbers

- **Fresh process**: DE market peak ≈ 762 MB, AT ≈ 507 MB — well under 4 GB.
- **2nd run same process (after crash recovery)**: DE market ≈ 4049 MB → immediate OOM with 4096 MB limit.
- **Schema validation of meta-base.csv** (362 MB file): adds ~500 MB during `validateMetaFeed`. With accumulated heap this triggers OOM; with a fresh process it is fine.

## Current strategy

1. Run legacy Meta layer generation in a fresh child process.
2. Run each public language feed (FR and DE) in its own subsequent fresh child process.
3. Stream every large CSV directly to storage and validate rows as they are written; never materialize a complete public feed or re-download a complete base file for validation.
4. Read language-feed rows from the persisted canonical cache in small, ordered pages. Deterministic DB ordering is sufficient; an in-memory final sort is not.

## Files involved

- `artifacts/api-server/src/exporters/meta/generator.ts` — the export function
- `artifacts/api-server/package.json` — `--max-old-space-size` for the server process
- `config/feed-policy.yaml` — `snapshot_gate.require_zero_schema_errors`

**Why:** The in-process export design was chosen for simplicity, but it means a long-running server accumulates V8 old-gen objects. Each run adds to the irreducible old-gen floor, so repeated runs on the same process eventually OOM.

**How to apply:** Any new Meta publish path must use the fresh-process runner. Do not reintroduce `rows.push(...)`, synchronous whole-file CSV serialization, or post-upload full-file validation for large feeds. If one child crashes, retry only that child from a fresh process; the API server and other completed phases remain safe.
