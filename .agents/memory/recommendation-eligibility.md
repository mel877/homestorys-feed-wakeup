---
name: Recommendation market eligibility
description: Recommendation generation must filter both source and candidate pools to eligible, positive-priced variants in the target market; never rely on "first variant per product" for pricing.
---

## Rule
When building `RecommendationProduct` records for a market:
1. Query only `isEligible=true` market variant rows for the target market.
2. Build a `variantProductMap` (variantId → productId) from ALL variants.
3. Build `eligibleMvByProductId` (productId → best eligible MV) by joining through `variantProductMap`.
4. Exclude products with no entry in `eligibleMvByProductId` from both source and candidate pools.
5. Use `eligibleMvByProductId.get(p.id)` for price/availability — NOT `variantByProduct.get(p.id)` followed by a price lookup (the first-variant may be ineligible while another is eligible).

**Why:** A product can have multiple variants. The "first variant encountered" is arbitrary; if that variant is ineligible or unpriced in the target market, a naive lookup gives null price and "out_of_stock" availability, corrupting scoring. The backfill script and the in-process runner must use the same eligibility logic.

**How to apply:** Separate the two lookups: `variantByProduct` for metafields (style/material/discontinued — product-level signals where any variant works), `eligibleMvByProductId` for market price/availability (must be the eligible one).
