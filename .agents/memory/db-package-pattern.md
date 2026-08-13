---
name: @workspace/db import and typecheck pattern
description: The db package exports from .ts source via TypeScript project references; must compile first after schema changes.
---

## Rule
After any schema change in `lib/db/src/schema/`, run:
```
pnpm tsc -p lib/db/tsconfig.json
```
before running `pnpm --filter @workspace/api-server run typecheck`.

**Why:** The db package uses `composite: true` TypeScript project references. The api-server consumes it via `@workspace/db` path alias. If `.d.ts` files are stale, the api-server typecheck will fail with "module not found" or missing type errors.

**Shopify GraphQL quirk:** Use `edges { node { ... } }` syntax in bulk operation queries — NOT simplified `connection { field }` form (Shopify rejects that).
