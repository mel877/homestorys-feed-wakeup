---
name: made_to_order return class → backorder availability
description: Variants with returnClass=made_to_order or backorder must set sellWhenOutOfStock=true in computeInventory.
---

## Rule
In `builder.ts`, derive `sellWhenOutOfStock` from the variant's `metafieldReturnClass`:
```ts
const sellWhenOutOfStock = returnClassRaw === "made_to_order" || returnClassRaw === "backorder";
```

**Why:** Without this, a made-to-order product with 0 warehouse stock shows `out_of_stock` instead of `backorder`. The return class is the correct signal — Shopify's "continue selling when out of stock" flag is not in the current schema.

**How to apply:** Set this before the `computeInventory` call. The `returnClass` resolution (metafield ?? config.returns.default_class) happens earlier in the builder and can be reused.
