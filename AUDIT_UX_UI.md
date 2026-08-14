# AUDIT_UX_UI

Date: 2026-08-14. Method: Playwright walkthrough of every dashboard page + manual review of every interactive element.

## Issues

| Page | Component | Sev | Problem | Impact | Recommendation | Implemented |
|------|-----------|-----|---------|--------|----------------|-------------|
| Product debug | Inventory tab | P1 | Blank panel — trigger without content | Operator sees nothing, thinks feature is broken | Render inventory-by-location table + empty state | ✅ Yes |
| Product debug | Recommendations tab | P1 | Blank panel | Same | Per-market related/complementary table, links, empty state explaining nightly run | ✅ Yes |
| Products | Table row | P1 | Full-page reload to wrong URL on row click | Broken navigation | Client-side wouter navigation | ✅ Yes |
| Feeds | Page header | P1 | No way to generate feeds ("read-only viewer" of something that had never run) | Core action missing | "Generate feeds" button + toast + 10s polling for 30 min | ✅ Yes |
| Runs | Dispatch buttons | P2 | Recommendations run type supported by API, no button | Hidden capability | Button added | ✅ Yes |
| Images | Page copy | P3 | "Review automated image classifications" implies actions; page is read-only | Mild expectation mismatch | Classification progress/actions owned by Tasks #16/#22 — not duplicated here | ➖ Deferred to tasks |
| Data quality | Table | P3 | No remediation path from low-quality rows | Operator must navigate manually | Product links exist; deeper quality visibility owned by Task #20 | ➖ Deferred to task |
| Google | Page | P3 | Status-only; no push/retry control | Push happens via sync pipeline by design; needs GOOGLE_MERCHANT_ID | Consider a "Push to Google" action once merchant ID configured | ❌ Not yet |
| All | Login page console | P3 | One 404/401 console entry pre-login (auth probe) | Cosmetic | Acceptable; could silence by treating 401 as expected | ❌ Not yet |

## Copy audit (Phase 39)
Labels are specific and unambiguous: "Full Sync", "Inventory", "Prices", "Recommendations", "Generate feeds" — no generic "Go/Process" buttons found. Sidebar names match page titles. Locale/market codes shown in monospace consistently.

## Global evaluation
| Axis | /10 | Notes |
|------|-----|-------|
| Navigation | 8 | Clear sidebar, consistent routes; row-click bug fixed |
| Onboarding | 6 | Single-password login is simple; no first-run guidance, acceptable for internal ops tool |
| Clarity | 8 | Real metrics everywhere, exclusion reasons surfaced per variant |
| Rule builder | n/a | Rules are versioned YAML config by design (single-tenant engine), no UI editor |
| Mapping UX | n/a | Channel mapping is code/config; debug view shows per-channel output per product |
| Feed configuration | 6 | Generate button added; channel enable/disable & scheduling remain config-file-only |
| Tables | 8 | Consistent shadcn tables, pagination, filters, empty states |
| Visual consistency | 9 | Single design system, consistent badges/typography |
| Error handling | 7 | Toasts on failures, run error tables, 409 conflicts surfaced; orphaned-run reaper still missing (F-12) |
| Professional SaaS feel | 8 | Coherent internal-ops product |

Identity preserved — no decorative redesign performed (Phase 49 rule).
