# CHANNABLE_PARITY_MATRIX

Benchmark: Channable as a product-maturity reference — NOT a feature-copy target.
Context: this engine is deliberately **single-tenant, single-source** (one Shopify store → Google + Meta). Multi-project/multi-source features are ⚫ out of scope unless the product direction changes.

Legend: ✅ Functional · 🟡 Partial · 🔴 Missing · ⚫ Not relevant / out of scope
Priority: P0 indispensable · P1 important · P2 improvement · P3 advanced/future

| Category | Status | Priority | Notes |
|----------|--------|----------|-------|
| Projects (multi-project/workspace) | ⚫ | P3 | Single-tenant by design; auth is one shared operator password |
| Imports (product source) | ✅ | P0 | Shopify GraphQL bulk sync (full/inventory/prices/webhooks), run tracking, checkpoints |
| Import mapping | ✅ | P0 | Fixed canonical model built from Shopify fields + metafields; correct for single known source |
| Fields (custom fields) | 🟡 | P2 | Metafield-driven; adding a new field requires code, not config |
| Products (catalog explorer) | ✅ | P0 | Search/filter/pagination, per-product debug view (variants, markets, content, images, inventory, feed output, recommendations) |
| Rules (IF/THEN engine) | 🟡 | P1 | Business rules exist (eligibility gates, labels, category mapping, returns/shipping policies) but as versioned YAML config, not an operator-editable UI rule builder |
| Rule groups / ordering | 🟡 | P2 | Deterministic pipeline order in code; no UI reordering |
| Categories | ✅ | P1 | Canonical category pipeline + per-channel overrides (per-channel isolation verified) |
| Channels | ✅ | P0 | Google (Content API push) + Meta (public CSV feeds); adding channels = code |
| Channel templates | 🟡 | P2 | Per-channel mappers in code; correct output, not templatized |
| Channel mapping | ✅ | P0 | Canonical → Google TSV / Meta CSV mappers, per market × language |
| Quality check | ✅ | P1 | data_quality_score per feed item, dashboard page, thresholds, channel diagnostics from Merchant Center |
| Preview | 🟡 | P1 | Per-product feed output tab + downloadable snapshots; no pre-publish diff preview |
| Export | ✅ | P0 | **Fixed this audit**: standalone export run + Generate Feeds button; atomic versioned publish |
| Public feeds | ✅ | P0 | Meta: public URLs (base/lang/country). Google: API push (public URL not needed) |
| Scheduling | ✅ | P1 | Cron config: full 02:00, inventory hourly, prices 2h, recommendations 03:00; config-file only (no UI) |
| History | ✅ | P1 | sync_runs + sync_errors, run detail UI, checkpoints |
| Monitoring / observability | 🟡 | P1 | feed-health endpoint, alerts, channel diagnostics; missing: orphaned-run reaper (F-12), per-phase progress (Task #22) |
| Permissions | ⚫ | P3 | Single shared operator credential; fine for internal tool, blocker only if multi-user is required |
| UX | ✅ | P1 | See AUDIT_UX_UI.md — 2 blank-tab bugs and nav bug fixed |
| Performance | 🟡 | P2 | Canonical build ~3 min/market during export; image classification throughput fixed by Task #16; no N+1 found in dashboard queries (single aggregate endpoints) |

## Answer to the final question
> "Can I hand this platform today to a client who normally uses Channable for Google/Meta feeds, without intervening behind the scenes?"

**For this specific store (Homestorys) as a managed single-tenant engine: yes for Meta, conditionally for Google** — Google push requires `GOOGLE_MERCHANT_ID` + credentials to be configured in the target environment. **As a self-service Channable replacement for arbitrary clients: no** — rules, channel mapping, and scheduling are engineering-controlled config, not operator-editable UI (see 🟡 rows, all P1/P2). That is an intentional architecture choice, not a defect.
