---
name: Durable feed pump boundaries
description: Safety and granularity rules for resumable Google and Meta feed exports on Autoscale.
---

Build work must be split into deterministic, idempotent batches that write only run-specific versioned parts. A separate file-finalization barrier may assemble, validate, apply the item-count guardrail, and atomically publish only after every required batch and market contribution is complete. Finalization truth comes from PostgreSQL step records plus recalculated App Storage checksums. The current snapshot is a singleton PostgreSQL pointer to an immutable versioned artifact, not a multi-object `current` copy.

**Why:** Wrapping an existing monolithic exporter in a leased job is not resumability: an Autoscale interruption still loses the work. Publishing per partial market can also replace valid shared Google language or Meta base/language/country layers with incomplete files. Multi-object file/manifest copies cannot switch atomically, and live source reads across batches can silently mix catalog revisions.

**How to apply:** Claims use short expiring leases and deterministic source cursors. Capture each batch's canonical source once; bracket live capture with current semantic fingerprints that exclude volatile timestamps, and make retries read only frozen payloads. Validate assembled feeds incrementally; cap retained errors and spill exact duplicate-ID detection to recursively partitioned temporary files. Parts and final artifacts are create-only. Serialize finalization by feed target across runs; derive expected indexes from the finalize step; switch the DB pointer only after immutable file and manifest validation. Never update current pointers during a build batch.

The internal feed pump is a consumer of already-planned steps, not a run planner. It must await recovery, claim, execution, and persistence; dispatch only durable build/finalize handlers; and enforce the request budget by refusing new claims after the deadline. Finalize rows are claimable only after their DB barrier is complete. Normal finalizer-lock contention defers without consuming an attempt; exhausted failures are terminal, not retries.

Planning is a separate authenticated action with explicit confirmation. It freezes the active product ID set and source fingerprints, then atomically creates one export run and all Google/Meta build and finalize steps under a transaction-scoped advisory lock. It must refuse while any durable step is pending/running and must never invoke the pump or touch snapshots.