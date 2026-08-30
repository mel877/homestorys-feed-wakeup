---
name: Nightly cycle ownership
description: Defines the single-orchestrator rule for scheduled Shopify refresh and feed publication.
---

GitHub Actions is the sole scheduled orchestrator for the durable nightly Shopify-to-feed cycle. The in-process scheduler may run recommendations, but must not schedule Shopify product, pricing, inventory, Full Sync, Google, or Meta batch jobs.

**Why:** Independent in-process Shopify jobs can start at the same time as the durable cycle, mutate canonical data between gate and fingerprinting, and invalidate the claim that one source refresh produced one coherent feed plan.

**How to apply:** Keep manual administration routes and real-time webhooks available, but route every scheduled batch refresh and feed publication through the durable cycle endpoint and its persisted leases/gates.