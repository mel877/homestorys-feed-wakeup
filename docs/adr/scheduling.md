# ADR-001: Sync Scheduling Architecture

**Date:** 2026-08-13  
**Status:** Accepted  
**Context:** Task #5 — Sync Orchestration & Scheduling  

---

## Context

The Homestorys feed engine must keep Google Merchant Center and Meta Catalog
feeds up to date with Shopify inventory, prices, and catalog changes. We need
to decide how to schedule and orchestrate the four recurring sync jobs:

| Job                  | Cadence            | Purpose                              |
|----------------------|--------------------|--------------------------------------|
| Full catalog sync    | Nightly (02:00 UTC)| Products, translations, all markets  |
| Inventory sync       | Every 1 hour       | Stock levels per location + market   |
| Price sync           | Every 4 hours      | Market pricing, discounts, compare-at|
| Recommendations sync | Nightly (03:00 UTC)| Related + complementary scoring      |

---

## Decision: In-Process Scheduler

We implement a lightweight **in-process scheduler** running inside the same
Reserved VM worker process as the API server, rather than using an external
orchestrator (Temporal, BullMQ, cron daemon, etc.).

### Implementation

- `src/jobs/scheduler.ts` uses `setTimeout`/`setInterval` directly, avoiding
  any external dependency. Daily jobs use `setTimeout` calibrated to the next
  UTC fire time; periodic jobs use `setInterval`.
- Concurrency guard: an in-memory `Set<string>` tracks running jobs, combined
  with a DB check for active `sync_runs` records younger than 2 hours. This
  prevents duplicate runs both within a process (re-entrancy) and across process
  restarts (stale in-memory state won't confuse a fresh boot).
- The scheduler starts asynchronously on server startup via a dynamic import so
  it does not delay HTTP readiness.

### Why Not PostgreSQL Advisory Locks?

PostgreSQL advisory locks are session-scoped, which creates a problem with
connection pools: `pg_advisory_lock` acquired on one pool connection may be
released when that connection is returned to the pool. Workarounds (holding a
dedicated connection, using `pg_advisory_xact_lock` in a long transaction)
add complexity without matching benefit.

The `sync_runs` table already provides sufficient mutual-exclusion semantics:
a row in `status='running'` with `started_at > NOW() - 2h` is treated as a
live lock. This is process-restart-safe and does not require managing a
dedicated DB connection.

### Why Not an External Scheduler?

**BullMQ / Redis**: adds a Redis dependency, operational cost, and failure modes
for a single-VM deployment. Overkill for four infrequent jobs.

**Temporal**: excellent for complex workflow orchestration but far beyond the
scope of four cron-like jobs on a single VM.

**System cron (`crontab`)**: would require a separate process, and the Replit
Reserved VM does not expose system cron to the app layer.

**`node-cron` package**: would work but adds an external dependency for
functionality achievable with `setTimeout`/`setInterval` + a one-time UTC
next-fire calculation.

---

## Concurrency & Idempotency

- **Full sync**: uses `checksum`-gated upserts — running twice produces the
  same result. Only changed variants trigger downstream exporter re-runs.
- **Inventory sync**: upsert with `updated_at` — idempotent.
- **Price sync**: upsert with `updated_at` — idempotent.
- **Recommendations sync**: `ON CONFLICT DO UPDATE` — idempotent.

If a job is skipped (lock held), the next scheduled tick will pick it up.

---

## Alerting

Post-run alert checks fire after each full sync via `checkAlerts()` in
`src/observability/alerts.ts`. Conditions (spec §43):

1. Full sync failure (last run status = `failed`)
2. Product count drop > 5% between consecutive full syncs
3. Price invalidity rate > 2% in `channel_diagnostics`
4. Meta feed not refreshed within 6 hours
5. Stock data older than 3 hours
6. Critical Merchant Center diagnostics (severity = `disapproved`)

Alerts are logged to `sync_errors` with `error_type = 'alert_<type>'` and
optionally POSTed to `ALERT_WEBHOOK_URL`.

---

## Feed Health KPIs (spec §41)

`GET /api/feed-health` returns:

```json
{
  "overallStatus": "healthy | warning | critical",
  "activeAlerts": [...],
  "syncSummary": { "full": {...}, "inventory": {...}, "prices": {...}, "recommendations": {...} },
  "lastRuns": {...},
  "feedSnapshots": { "google": { "latestGeneratedAt": "...", "totalItems": 0, "ageMinutes": 0 }, "meta": {...} },
  "eligibilityCounts": [...],
  "marketCounts": [...],
  "generatedAt": "..."
}
```

---

## Consequences

- **+** Zero external dependencies beyond what already exists.
- **+** Simple, readable code with no worker/queue abstraction.
- **+** Process restart is safe — scheduler re-arms itself from scratch; the DB
  `sync_runs` check prevents double-runs.
- **−** If the server process crashes mid-job, the `sync_runs` record stays
  `running` for up to 2 hours before a new run is allowed. Acceptable given
  nightly/hourly cadences.
- **−** No job history or retry UI beyond what's in the `sync_runs` table.
  Acceptable for an internal feed engine.
