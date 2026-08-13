---
name: Category override per-channel rule
description: Metafield category overrides (Google/Meta) apply to their own channel only; they must not clear the other channel's pipeline value.
---

## Rule
When a product has a `feed.google_category` or `feed.meta_category` metafield override:
- Override only replaces the channel it belongs to (googleCategoryId or metaCategory).
- The other channel retains its normal pipeline value (explicit → collection → fuzzy → fallback).
- `canonicalCategory` always comes from the pipeline — it is NEVER set to null because of an override.

**Why:** The original implementation returned early when either override was present, setting both channels from overrides and leaving `canonicalCategory: null`. This caused products with only a Google override to lose their Meta category, making them invisible to the Meta feed. The reviewer caught this.

**How to apply:** In `mapCategory` (now in `@workspace/rec-engine/src/category-mapper.ts`): run `runPipeline()` first unconditionally, then overlay the override fields individually on the base result.
