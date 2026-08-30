---
name: Durable pricing progress
description: Durable Shopify pricing slices must make bounded useful progress and atomically checkpoint business writes.
---

Pure validation loops must process a bounded batch per HTTP pump call, not one variant-market pair per poll.

**Why:** A logically resumable one-item validation step can require hundreds of thousands of external polls for a large catalog, appearing permanently stuck despite successful responses.

Sequential per-market upserts must be grouped into bounded multi-row SQL operations rather than merely increasing the number of sequential statements inside one HTTP slice.

**Why:** Transaction overhead and network round trips, not the row count alone, can dominate pricing duration and push otherwise durable requests toward their timeout.

**How to apply:** Keep CHF validation before all writes, advance deterministic validation indices in batches, and persist each grouped market-price write batch with its next checkpoint through the lease-fenced transaction helper.