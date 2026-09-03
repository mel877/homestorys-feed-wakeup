---
name: Canonical feed URL paths
description: Live storefront routing constraints behind canonical Google and Meta MARKET product links.
---

For Google and Meta MARKET links, FR and BE_FR use `/fr/`, CH_FR uses `/fr-ch/`, and CH_DE uses `/de-ch/`. DE, BE_DE, AT, and LU_DE use the canonical origin root directly before `/products/...`; do not add `/de/`.

**Why:** Read-only live probes on September 3, 2026 found `/de/products/...` returned 404 for multiple real German handles, while `https://shop.homestorys.com/products/...` returned 200 with German content. The user explicitly chose the verified root route.

**How to apply:** Preserve the product handle and `variant` query exactly. Re-probe the live storefront before changing these prefixes because Shopify market routing can change independently of the feed engine.