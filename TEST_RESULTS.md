# TEST_RESULTS

Date: 2026-08-14

## Summary
- Executed: 3 categories — API behavior checks (curl), full-pipeline data verification (SQL/API), Playwright e2e dashboard audit.
- Passed: all except one e2e failure (blank Inventory tab) which was fixed and re-covered.
- Failed (before fix): 1 — product-debug Inventory tab blank (F-05). Fixed same session.
- Skipped: Google Merchant Center push (no `GOOGLE_MERCHANT_ID` configured in dev — export logs an explicit error, does not silently pass).

## E2E (Playwright testing agent)
Flow: login → overview → products search "sofa" → row-click navigation → product debug (all 7 tabs) → sync runs (4 dispatch buttons) → Google, Meta, Images, Inventory, Data Quality, Feeds pages.

| Step | Result |
|------|--------|
| Password login → /overview redirect | ✅ |
| Overview metrics (2,718 products, market breakdown, recent runs) | ✅ |
| Products search (debounced) + filtered results | ✅ |
| Row click → client-side nav to /products/:id, no reload/404 | ✅ (regression fix verified) |
| Tabs: Variants, Markets, Content, Images, Feed Output | ✅ |
| Tab: Recommendations — informative empty state | ✅ (regression fix verified) |
| Tab: Inventory | ❌ blank → fixed (TabsContent added) |
| Sync Runs: Recommendations/Prices/Inventory/Full buttons + history | ✅ |
| Google, Meta, Images, Inventory, Data Quality, Feeds pages | ✅ real data / sensible empty states |
| Console | 1 non-blocking 404 on initial load (expected: `/api/dashboard/auth/me` 401-path probing before login); no errors after login |

## API checks (curl)
| Check | Result |
|-------|--------|
| GET /api/health | ✅ 200 |
| GET /api/feed-health | ✅ 200, real KPIs + active alert list |
| Dashboard login / me / protected 401s | ✅ |
| GET /api/recommendations/:uuid | ✅ 200 (empty until nightly run) |
| GET /api/recommendations/not-a-uuid | ✅ 400 (was 500) |
| POST trigger runType=export | ✅ 202, run row created, 409 on duplicate |
| GET /api/feeds/meta/base.csv | 404 before first export (expected); re-verified after export completion |

## Pipeline data verification (SQL/API)
- Full sync `40920f5b` phases 1–4: products 2,718; market_variants 191,815 (FR/DE price lists applied; unmatched Shopify markets intentionally skipped); inventory levels 55,426; EN translations 2,096.
- Orphaned runs marked failed with reason in `metadata` JSONB (no silent "running" ghosts).
- Standalone Meta per-market export produced and atomically published BE_FR country feed (~3 min/market); shared base+language layers correctly refuse to publish from a partial catalog ("not safe to publish partial catalog" guard verified).

## Typecheck / build
- `tsc --noEmit`: ✅ api-server, ✅ dashboard (after fixes).
- orval codegen (OpenAPI → zod + react client): ✅ regenerated, in sync.
