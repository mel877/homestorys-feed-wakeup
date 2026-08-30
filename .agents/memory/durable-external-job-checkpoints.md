---
name: Durable external-job checkpoints
description: Safety requirements for resumable Shopify bulk work and other externally-created jobs.
---

For resumable batch work, commit each data unit and advance its durable cursor in the same database transaction, conditioned on the worker still owning an unexpired lease. A later, separate checkpoint write permits replay after a crash.

**Why:** External bulk jobs and database writes create two failure windows: the process can disappear after creating the remote job but before saving its ID, or after committing data but before advancing the cursor. Idempotent upserts reduce damage but do not provide exact continuation.

**How to apply:** Correlate/adopt remote jobs using a stable remote field such as the normalized Shopify BulkOperation query. Inside every product, inventory, pricing, or translation unit, lease-check, write data, and advance the step cursor atomically.