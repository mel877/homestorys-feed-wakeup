---
name: Shopify API 2025-01 field migrations
description: Fields removed or restructured in Shopify Admin API 2025-01 that broke the feed engine sync — and their replacements.
---

# Shopify API 2025-01 — Breaking field changes

**Why:** The app uses `SHOPIFY_API_VERSION=2025-01` (default). Several fields were deprecated/removed between older versions and 2025-01. Each caused a GraphQL error on the affected sync phase.

## ProductVariant — weight / requiresShipping
- **Old:** `weight`, `weightUnit`, `requiresShipping` directly on `ProductVariant`
- **New:** inside `inventoryItem { requiresShipping, measurement { weight { value unit } } }`
- **Files:** `sync-products.ts` (bulk query + single product query + mapping)

## Market web presence — defaultLocale
- **Old:** `defaultLocale` was a plain string
- **New:** `defaultLocale { locale }` (object)
- **Files:** `sync-markets.ts` (MARKETS_QUERY + mapping), `types.ts` (ShopifyMarketWebPresence)

## PriceListParent — market field
- **Old:** `priceLists { nodes { parent { market { id name handle } } } }`
- **New:** market is found via `catalog { ... on MarketCatalog { markets { nodes { id name handle } } } }`
- **Files:** `sync-markets.ts` (PRICE_LISTS_QUERY + mapping loop), `types.ts` (ShopifyPriceList)

## InventoryLevel — available
- **Old:** `inventoryLevels { edges { node { available } } }`
- **New:** `inventoryLevels { edges { node { quantities(names: ["available"]) { name quantity } } } }`
- **How to apply:** extract `quantities.find(q => q.name === "available")?.quantity ?? 0`
- **Files:** `sync-inventory.ts` (BULK_INVENTORY_QUERY, SINGLE_INVENTORY_QUERY, interfaces, mapping), `types.ts` (ShopifyInventoryLevel)

## TranslatableResources — resourceType enum
- **Old:** `translatableResources(resourceType: ONLINE_STORE_PRODUCT, ...)`
- **New:** `translatableResources(resourceType: PRODUCT, ...)`
- **Files:** `sync-translations.ts`

## Product images — bulk op GID type
- **Old:** `isImageNode` checked for `/MediaImage/` or `/Image/` in the GID
- **New:** Shopify bulk op emits `gid://shopify/ProductImage/...` — the string `/Image/` does NOT match `ProductImage`
- **Fix:** also check `n.id.includes("/ProductImage/")`
- **Files:** `sync-products.ts` (isImageNode function)

## ShopifyClient — errors field type
- Shopify occasionally returns `{ "errors": "some string" }` (not an array) when a token is revoked (e.g. after app reinstall).
- **Fix:** normalize `body.errors` to array before calling `.some()`. Also clear `this.cachedToken` on 401 from both `requestRest` and `request`.
- **Files:** `client.ts`

## How to apply
When targeting a newer API version, always check these field paths against the Shopify schema changelog for the target version.
