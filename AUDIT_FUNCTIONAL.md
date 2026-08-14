# AUDIT_FUNCTIONAL

Functional audit — Homestorys Feed Engine (Shopify → Google Merchant Center / Meta catalog).
Date: 2026-08-14. Method: every finding verified against live behavior (API calls, DB queries, Playwright e2e), not code reading alone.

## Application shape (verified)
- **Source**: single Shopify store (`villaromana01.myshopify.com`), API version 2025-01. Full/inventory/price/recommendation syncs, plus HMAC-verified webhooks.
- **Pipeline**: Shopify sync → canonical model (config-driven rules in `config/*.yaml`, versioned in `config_versions`) → eligibility/quality gates → per-channel mappers → feed_items + published feed files (App Storage) + feed_snapshots.
- **Channels**: Google (Merchant Center Content API push + dashboard-download TSV) and Meta (public CSV feed URLs under `/api/feeds/meta/...`).
- **Operator UI**: password-protected dashboard (overview, products, product debug, runs, Google/Meta status, images, inventory, data quality, feeds).

This is intentionally a single-tenant, single-source feed engine — not a multi-project Channable clone. See CHANNABLE_PARITY_MATRIX.md.

## Findings

| ID | Sev | Area | Problem | Root cause | Fix | Status | Test |
|----|-----|------|---------|-----------|-----|--------|------|
| F-01 | P0 | Inventory webhooks | Webhook-touched variants all marked out_of_stock | Shopify 2025-01 removed `node.available`; code read it → NaN | Read `quantities[name=available]` | ✅ Fixed | Typecheck + code path review; full sync re-verified counts (55,426 inventory levels) |
| F-02 | P1 | Translations | Existing titles wiped with `""` when a locale lacked a title translation | Upsert conflict-set used `title ?? ""` | Conflict-update sets title only when present | ✅ Fixed | tsc + upsert logic verified both paths |
| F-03 | P1 | Feed generation | Feeds could ONLY be generated as a side effect of a multi-hour full sync; "Meta feed never generated" alert active since inception | No standalone export trigger | New `runType: "export"` + Feeds page button | ✅ Fixed | Export run `740f8737` dispatched via API, tracked in sync_runs |
| F-04 | P1 | Feed publish concurrency | Standalone export and post-full-sync export could publish concurrently → race-dependent current feed | Distinct lock names per path | Shared `feed-export` lock across all 4 publish paths | ✅ Fixed | tsc; lock name unified (found by code review round) |
| F-05 | P1 | Product debug UI | Inventory and Recommendations tabs rendered blank panels (fake UI) | TabsTrigger declared without TabsContent | Real tables + informative empty states | ✅ Fixed | Playwright: all 7 tabs render (failure→pass) |
| F-06 | P1 | Products list | Row click did a full page reload to `/dashboard/products/:id` (wrong base path) | Hardcoded `window.location.href` | wouter `navigate()` | ✅ Fixed | Playwright: client-side nav, no 404 |
| F-07 | P2 | Public recommendations API | 500 on non-UUID product id | Unvalidated uuid cast in SQL | 400 + UUID regex | ✅ Fixed | curl: 500→400 |
| F-08 | P2 | Sync metrics | Market sync double-counted changed records | bumpChanged in batch + fallback | Count once | ✅ Fixed | Code review verified |
| F-09 | P2 | Runs UI | Recommendations sync supported by API but no button | Unfinished UI | Button added | ✅ Fixed | Playwright: 4 buttons present |
| F-10 | P2 | Feeds UI | Snapshot list stale after dispatch; no feedback loop | No invalidation/polling | Poll 10s for 30 min after dispatch | ✅ Fixed | tsc (found by code review round) |
| F-11 | P3 | Hygiene | Dead code (`waitMs`), unused imports | Leftovers | Removed | ✅ Fixed | tsc |
| F-12 | P2 | Observability | `sync_runs` has no failure reason column; orphaned "running" runs survive restarts until manually failed | Schema gap; no startup reaper | Reason stored in `metadata` JSONB manually | 🟡 Open (P2) — recommend a startup reaper marking orphaned running runs failed | Manual SQL used twice this session |
| F-13 | P3 | Scopes check | Non-blocking 404 warning `/access_scopes.json` at sync start | REST endpoint mismatch | None (cosmetic, sync continues) | 🟡 Open (P3) | Observed in logs |
| F-14 | — | Image classification throughput | Phase 5 drained ~4 img/s over 41k images (hours) | Downloads every image | Owned by Task #16 (task agent, IMPLEMENTED, pending merge) | ⏳ External | — |
| F-15 | — | Schema drift / deploy migrations / no-image products / quality visibility | — | — | Owned by proposed Tasks #17–#20 | ⏳ External | — |

## Verified-working (no action)
- Full sync phases 1–4: 2,718 products / 82,114 nodes / 191,815 market_variants (FR+DE price lists; be/europe/insel/switzerland/US intentionally unmatched) / 55,426 inventory levels / translations EN 2,096 (DE/IT: none exist in Shopify — expected).
- Auth: all dashboard routes 401 without session; internal routes require `INTERNAL_API_SECRET`; webhooks HMAC-verified; Google feed downloads auth-gated; Meta feeds deliberately public (crawler requirement).
- Health endpoints, feed-health KPIs, run history + error detail, 409 on concurrent same-type sync trigger.
- All dashboard pages load real DB-derived data (Playwright audit) — no mocked/decorative numbers found.
