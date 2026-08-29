---
name: Durable feed pump boundaries
description: Safety and granularity rules for resumable Google and Meta feed exports on Autoscale.
---

Build work must be split into deterministic, idempotent batches that write only run-specific versioned parts. A separate file-finalization barrier may assemble, validate, apply the item-count guardrail, and atomically publish only after every required batch and market contribution is complete.

**Why:** Wrapping an existing monolithic exporter in a leased job is not resumability: an Autoscale interruption still loses the work. Publishing per partial market can also replace valid shared Google language or Meta base/language/country layers with incomplete files.

**How to apply:** Claims use short expiring leases and deterministic source cursors. Batch retries replace the same part instead of appending duplicates. Google language and Meta shared layers require their full configured contribution sets before finalization. Never update current pointers during a build batch.