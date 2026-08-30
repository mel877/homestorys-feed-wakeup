---
name: Meta market snapshot composition
description: Durable rules for composing complete Meta market feeds from layered snapshots.
---

COUNTRY snapshots are shared by all configured markets for a country. A complete market feed must select only IDs ending in the exact `_<marketCode>` suffix before joining BASE and LANGUAGE by the unchanged full ID.

**Why:** Bilingual countries such as BE and CH place both language-market ID sets in one COUNTRY snapshot. Joining the whole country file against one LANGUAGE snapshot makes valid rows from the other language look missing.

**How to apply:** Keep component IDs unchanged, use COUNTRY as the selected market row set, and require an exact BASE and LANGUAGE match for every selected ID.

COUNTRY and MARKET snapshots can share a `marketCode` such as FR, DE, or AT. Their durable identity includes language: COUNTRY uses null language, while MARKET uses its configured language.

**Why:** Looking up by `marketCode` alone can serve a component snapshot from a complete-market URL, or the reverse.

**How to apply:** Resolve and replace current snapshots by `(channel, marketCode, language)`, not by `marketCode` alone.