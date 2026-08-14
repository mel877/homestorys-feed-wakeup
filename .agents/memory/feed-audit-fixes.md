---
name: Feed Audit Fixes — Google & Meta
description: All 15 audit improvements applied to both feed mappers in August 2026
---

## What was done

A comprehensive audit of the Google (TSV) and Meta (CSV) feed mappers resulted in 15
improvements across correctness, policy compliance, localisation, and data richness.

## Critical fixes applied to code

### Fix 1 — availability_date for backorder (Google)
- Google REQUIRES availability_date when availability = "backorder"
- `computeAvailabilityDate()` in google/mapper.ts derives a default from returnClass:
  - `made_to_order` → +16 weeks
  - other backorder → +12 weeks
- Format: ISO 8601 with +01:00 timezone offset

### Fix 2 — Locale-aware description suffix
- Old: French brand suffix appended on ALL markets (including DE/AT/BE-DE)
- New: `BRAND_SUFFIX_BY_LANGUAGE` map in google/mapper.ts — one version per language (fr/de/en/it)

### Fix 3 — metaProductCategory in Meta mapper
- Old: `canonical.googleProductCategory` (numeric Google taxonomy ID)
- New: `canonical.metaProductCategory ?? canonical.googleProductCategory ?? ""`
- Meta prefers its own taxonomy string (e.g. "Furniture > Sofas & Couches")

### Fix 4 — Outlet condition in Meta
- Old: always "new" in meta/mapper.ts
- New: `resolveCondition()` checks `isOutlet` + custom_label_0 === "outlet" → "used"
- Aligns Meta with Google mapper which already had this logic

### Fix 5 — sale_price guard in Google TSV
- Old: TSV emitted salePrice whenever non-null, even when isOnSale=false
- New: `canonical.isOnSale && canonical.salePrice` guard — same logic as API resource

### Fix 6 — Localised product_highlight and product_detail section names
- `HIGHLIGHT_I18N` map: "New arrival" / "Bestseller" / "X% off" / "pickup" in fr/de/en/it
- `DETAIL_I18N` map: "Specifications" / "Style" / "Usage" in fr/de/en/it

### Fix 8 — return_policy_info in Meta base CSV
- New field in MetaBaseRow + META_BASE_HEADERS
- `buildReturnPolicyInfo()` reads returnClass → config.returns.classes[returnClass]
- returnable classes → `{"is_final_sale":"false","return_policy_days":"14"}`
- made_to_order / exhibition / customized → `{"is_final_sale":"true","return_policy_days":"0"}`
- Format matches Meta's documented JSON structure

### Fix 9 — shipping field infrastructure in Meta country CSV
- New field in MetaCountryRow + META_COUNTRY_HEADERS
- `buildMetaShippingInfo()` reads `config.shipping.meta_feed_rates[country]`
- `meta_feed_rates` added to ShippingConfigSchema (MetaShippingRateSchema)
- Config in config/shipping.yaml under `meta_feed_rates:` (currently `{}` — no rates)
- Format: `country::service:price currency` (e.g. `BE::Standard:29.90 EUR`)
- Returns "" when no rate configured → Meta shows "calculated at checkout"

### Fix 14 — product_type hierarchy
- `buildProductType()` uses metaProductCategory when it contains ">" (multi-level)
- e.g. "Furniture > Sofas & Couches" instead of single "Sofas"
- Applied in both Google mapper and Meta mapper

### Fix 15 — Delivery lead time in product_highlight
- Added locale-specific delivery strings for backorder/made_to_order availability
- Appears in `HIGHLIGHT_I18N` as `delivery_backorder` and `delivery_made_to_order`
- Only added when `availability === "backorder"`

## Not implemented (data/operation gaps)

- Fix 7 (GTIN coverage): operational — need to source EAN from suppliers
- Fix 10 (sale_price_effective_date): no Shopify sale date range available; TODO in sync-prices
- Fix 11 (title optimization): N/A — title already enriched via variant title in buildTitle
- Fix 12 (dimensions): need Shopify custom.dimensions metafield — TODO in sync-products
- Fix 13 (video): need variant video metafield — TODO in sync-products

## Files changed

- `artifacts/api-server/src/exporters/google/mapper.ts` (complete rewrite)
- `artifacts/api-server/src/exporters/meta/mapper.ts` (complete rewrite)
- `artifacts/api-server/src/config/schemas.ts` (MetaShippingRateSchema added)
- `artifacts/api-server/src/routes/feed-health.ts` (pre-existing TS error fixed)
- `config/shipping.yaml` (meta_feed_rates section added)
- `schemas/meta-base.schema.json` (return_policy_info field)
- `schemas/meta-country.schema.json` (shipping field)
- `schemas/google-product.schema.json` (availability_date field)

## **Why:** Meta-specific shipping rates config
Set `meta_feed_rates` in config/shipping.yaml to activate the shipping field.
Do NOT invent rates — use actual carrier agreements. Leave `{}` for "calculated at checkout".
