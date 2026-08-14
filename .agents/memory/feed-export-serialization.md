---
name: Feed export serialization
description: All Google/Meta feed publish paths must share one lock; publishes overwrite the same current storage paths and feed_snapshots rows.
---

Rule: every code path that runs the Google/Meta exporters (standalone export trigger, post-full-sync export in scheduler/internal-route/dashboard-trigger) must serialize behind the single shared `feed-export` lock (`withExportLock` in the exporters package).

**Why:** exporters overwrite identical "current" object-storage paths and toggle the same `feed_snapshots.is_current` rows; versioned paths are timestamped to the second, so concurrent publishes produce race-dependent current feeds. Found in a code-review round after adding the standalone export run type.

**How to apply:** when adding any new exporter invocation site (new channel, new trigger, CLI wired into server), wrap it in `withExportLock`. Never rely on distinct sync-run types or job names for this mutual exclusion. Also note: long-running exports cannot be launched as detached shell processes from agent sessions (they get reaped) — run them inside the persistent API server process via the export run type.
