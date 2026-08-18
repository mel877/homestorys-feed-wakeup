---
name: Shopify primary locale = German (de)
description: German is the Shopify store default language; sync architecture must account for this or DE translation rows stay at 0.
---

## The rule
German (`de`) is the Shopify store's **default/source locale**. It is NOT a Shopify "translation" — it is the base product content (title, body_html, handle) returned by all Shopify admin API product queries.

## Why this matters
Shopify's translation API (`translatableResources` → `translations(locale: "de")`) returns **empty arrays** for German because there is nothing to "translate to" — it's already the source. Any code that fetches `de` from the translation API will get 0 results silently.

## How to apply
- `config/languages.yaml`: `de` entry has `primary: true`
- `config/schemas.ts`: `LanguageSchema` has `primary: z.boolean().optional().default(false)`
- `sync-products.ts`: Reads `primary: true` from config → writes Shopify base content as `language = "de"` rows in `product_translations`
- `sync-translations.ts`: Skips the primary locale (de); fetches `fr`, `en`, `it` from Shopify translation API
- `routes/dashboard/overview.ts`: Uses config primary locale for coverage widget denominator
- `pages/overview.tsx`: Uses `overview.primaryLocale` from API response

## Why it broke originally
The system was built assuming French was the Shopify default (common for Belgian stores). When Shopify was reconfigured with German as default, `sync-products` kept writing German content labeled as `fr`, and `sync-translations` got 0 results for `de` from the API → 0 DE rows forever.

## After the fix
- Full sync → `de` rows populated from `products` table (German base content) ✅
- `fr` / `en` rows overwritten by real French/English translations from Shopify API ✅
- Dashboard: DE shows 2089/2089, no false alert ✅
- German market feeds (DE, AT, BE_DE) get real German titles/descriptions ✅
