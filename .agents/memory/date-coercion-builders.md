---
name: Date coercion in builders
description: JSON-parsed test fixtures produce string dates; builder/normalization functions must handle both Date and string types.
---

## Rule
Any function that receives a `Date` field sourced from Drizzle ORM or JSON fixtures must coerce it defensively before calling `.toISOString()` or `.getTime()`.

**Why:** Drizzle returns actual `Date` objects from PostgreSQL, but `JSON.parse()` (Vitest fixtures, API responses) produces plain strings. Using `instanceof Date` before calling date methods prevents `"publishedAt.getTime is not a function"` errors.

**How to apply:**
- In `builder.ts`: use a `toISOStringSafe(value: Date | string | null)` helper that returns the string as-is if it's already a string.
- In `normalization/index.ts` → `isNewProduct`: check `if (publishedAt instanceof Date) … else new Date(publishedAt as string)`.
- Pattern: coerce at the boundary where data enters the pure function, not inside every consumer.
