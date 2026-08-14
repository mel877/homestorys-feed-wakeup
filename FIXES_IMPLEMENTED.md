# FIXES_IMPLEMENTED

Audit remediation log — Homestorys Feed Engine. Date: 2026-08-14.
Scope: fixes made directly by the main agent. (Task agents separately delivered
#14 schema drift, #15 product image counts, #16 image-classifier throughput.)

## Backend (artifacts/api-server)

| # | Severity | File | Fix |
|---|----------|------|-----|
| 1 | P0 | `src/shopify/sync-inventory.ts` | Webhook single-item path read nonexistent `node.available` (Shopify API 2025-01 renamed it) → NaN → every webhook-touched variant marked out of stock. Now reads `quantities.find(q => q.name === "available")?.quantity ?? 0`. |
| 2 | P2 | `src/shopify/sync-markets.ts` | `tracker.bumpChanged` was counted twice per batch (batch + fallback). Batch count moved into `.then()`; fallback counts per-row only. Also replaced O(n) market `.find()` in hot loop with prebuilt Map. |
| 3 | P3 | `src/shopify/client.ts` | Removed dead `waitMs` logic; rate limiter + exponential backoff called directly. |
| 4 | P1 | `src/shopify/sync-translations.ts` | Translation upsert wiped existing titles with `""` when a locale had no translated title. Insert keeps `""` fallback (column NOT NULL); conflict-update now only sets `title` when a translated title exists. Applied to both bulk and per-product paths. |
| 5 | P2 | `src/routes/recommendations.ts` | Public endpoint returned 500 (unhandled uuid cast) for non-UUID product IDs. Now validates and returns 400. |
| 6 | P1 | `src/routes/dashboard/runs.ts`, `src/shopify/sync-run-tracker.ts`, `lib/api-spec/openapi.yaml` (+ regenerated zod/react clients) | Feeds could only be generated as a side effect of a multi-hour full sync. Added `runType: "export"`: regenerates Google + Meta feeds from already-synced canonical data, under the scheduler lock (`feed-export`), tracked as a `sync_runs` row with per-channel `sync_errors` on failure. |

## Frontend (artifacts/dashboard)

| # | Severity | File | Fix |
|---|----------|------|-----|
| 7 | P1 | `src/pages/products.tsx` | Product row click used hardcoded `window.location.href = /dashboard/products/:id` — full reload onto a wrong base path. Now wouter client-side `navigate(/products/:id)`. Verified by e2e tester (no reload, no 404). |
| 8 | P1 | `src/pages/product-debug.tsx` | Inventory and Recommendations tabs were declared but had NO content panels (blank pages — "fake UI"). Both tabs now render real tables with informative empty states; Recommendations tab shows per-market related/complementary product links. |
| 9 | P2 | `src/pages/runs.tsx` | Recommendations sync was supported by the API but had no dispatch button. Added. |
| 10 | P1 | `src/pages/feeds.tsx` | Feeds page had no way to generate feeds. Added "Generate feeds" button wired to the new export run type, with toast feedback. |
| 11 | P3 | `src/pages/products.tsx`, `src/pages/images.tsx` | Removed unused imports (`SlidersHorizontal`, `Input`) left over from unfinished controls. |

## Operational

- Orphaned sync run `41e4ff90` and `40920f5b` (killed by server restarts) marked `failed` with reason recorded in `metadata` JSONB (`sync_runs` has no failure_reason column).
- First-ever Meta feed generation initiated (was "never generated" alert in `/api/feed-health`).

## Migrations
None required — no schema changes. API contract change (`SyncTriggerInput.runType` enum + `export`) regenerated via orval from `lib/api-spec/openapi.yaml`.

## Tests
- Full typecheck passes (`tsc --noEmit` on api-server and dashboard).
- Playwright e2e audit of all dashboard pages by testing agent — see TEST_RESULTS.md.
