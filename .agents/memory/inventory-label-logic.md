---
name: Inventory label vs availability separation
description: deriveInventoryLabel must not short-circuit on out_of_stock before checking showroom stock; Eupen-only products must show "showroom" label.
---

## Rule
`deriveInventoryLabel` checks `online` vs `eupen` availability **after** the `discontinued` and `backorder` gates — NOT after `out_of_stock`. The `availability` field (which is online-stock-derived) and the `inventoryLabel` field serve different consumers.

**Why:** A product with 0 online stock but 1 Eupen stock still has `availability = "out_of_stock"` (for Google feed) but `inventoryLabel = "showroom"` (for Custom Label 4 and pickup badge). If we return `"out_of_stock"` early for the label whenever `availability === "out_of_stock"`, showroom-only products get the wrong label.

**How to apply:**
- `deriveInventoryLabel`: gate on `"discontinued"` and `"backorder"`, then fall through to the `onlineAvailable` / `eupenAvailable` checks unconditionally.
- Do NOT add `availability === "out_of_stock"` as an early-return gate in the label function.
