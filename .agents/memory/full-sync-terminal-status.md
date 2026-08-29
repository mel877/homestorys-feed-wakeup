---
name: Full Sync terminal status
description: Defines when a Full Sync may become completed versus degraded.
---

A Full Sync must remain non-terminal until Google and Meta exports have run sequentially under the shared export lock and every expected current DB snapshot and App Storage manifest identifies that Full Sync as its source. Expected per-market, country, and Meta layer paths come only from configured markets; public German/French aggregate paths remain mandatory. Historical paths outside the current configuration are ignored. An older expected current snapshot is an explicit fallback and forces `degraded`.

**Why:** Catalog ingestion can succeed while an export fails or leaves an older current pointer in place. Marking the run completed before provenance verification hides stale feeds from operators.

**How to apply:** Any Full Sync entry point must delegate lifecycle ownership to the common pipeline. Keep verification and final status persistence inside the export lock. Derive Meta language-layer expectations from languages represented by configured markets, while always verifying the public German/French aggregate feeds. If terminal persistence fails, leave the run non-successful so the startup reaper can recover it.