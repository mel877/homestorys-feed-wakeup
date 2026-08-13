---
name: Shared scoring lib
description: Pure recommendation and category functions live in @workspace/rec-engine; both the runtime engine and offline backfill must import from there.
---

## Rule
`scoreRelatedProducts`, `findComplementaryProducts`, and `mapCategory` are canonical implementations in `lib/rec-engine/src/`. The runtime API engine (`src/recommendations/engine.ts`, `src/categories/mapper.ts`) re-exports them. The backfill script imports directly from `@workspace/rec-engine`.

**Never copy these functions** into a consumer. Any divergence between backfill and runtime is a bug that produces different recommendation sets for the same DB state.

**Why:** The reviewer rejected multiple times because backfill had a copied algorithm with subtle differences (missing in_stock tie-break in last-resort, different category resolver). Structural parity via shared import eliminates the possibility of divergence.

**How to apply:** When adding a new pure function needed by both the runtime and backfill, add it to `lib/rec-engine/src/` first, then import in both consumers. Tests in `artifacts/api-server/tests/` import from `@workspace/rec-engine` directly to cover the shared code.
