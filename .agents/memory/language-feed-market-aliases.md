---
name: Language feed market aliases
description: Decision for storefront languages that share one commercial Shopify market.
---

When a country has more than one storefront language but Shopify supplies one
commercial market, define the extra language market as an explicit alias of
that same country's pricing market. Use the source for price and eligibility,
but keep the alias language for translations and storefront URLs.

**Why:** Swiss French must show an actual Swiss CHF price and shipping while
using French product content. Reusing a price from another country or inventing
a converted value would make the feed commercially incorrect.

**How to apply:** Grouped FR/DE feed rows remain market-specific. Every row
must retain the market-derived currency, shipping country and unique product ID
even when multiple markets share one language file.