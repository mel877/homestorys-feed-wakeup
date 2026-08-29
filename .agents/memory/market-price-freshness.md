---
name: Market price freshness
description: Why market_variants timestamps cannot establish price provenance or freshness.
---

Do not use `market_variants.updated_at` as evidence that a market price or currency was recently refreshed.

**Why:** Inventory synchronization updates availability and the same row timestamp without changing price fields. Old market prices can therefore appear freshly updated.

**How to apply:** Establish price freshness from a dedicated pricing run/provenance record or by fetching Shopify contextual pricing again; treat the row timestamp as “any market-row change,” not “price updated.”