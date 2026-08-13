# Homestorys Product Feed Engine

A Shopify → Google Merchant Center + Meta Catalog feed engine that replaces Channable. Pulls product, variant, pricing, inventory, and image data directly from the Homestorys Shopify store, applies market/language transformation rules, and exports to Google and Meta — with full observability, atomic snapshots, and rollback capability.

## Run & Operate

- `pnpm dev` — start the API server in development mode (port from $PORT)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run test` — run all tests (Vitest)
- `pnpm run lint` — ESLint across api-server, scripts, lib/db
- `pnpm run build` — typecheck + build all packages
- `pnpm bootstrap` — validate environment, test DB, print config summary
- `pnpm --filter @workspace/scripts run audit:shopify` — discover Shopify store structure
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM (14 tables)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Config: YAML files in `config/` + Zod validation at startup
- Testing: Vitest
- Linting: ESLint 9 (flat config) + typescript-eslint
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `config/` — YAML business config (markets, languages, stores, shipping, returns, categories, labels, feed-policy, complementary)
- `schemas/` — JSON Schema files (canonical-product, google-product, meta-product)
- `lib/db/src/schema/` — Drizzle table definitions (one file per domain)
- `artifacts/api-server/src/config/` — config loader + Zod validation schemas
- `artifacts/api-server/src/routes/` — API routes (health, feed-health, internal, webhooks, recommendations)
- `artifacts/api-server/src/middlewares/` — internal auth middleware
- `scripts/src/` — CLI scripts (bootstrap, audit-shopify, backfill, compare-feeds)
- `input/` — Channable reference files and business rule inputs (gitignored data files)
- `docs/adr/` — Architecture Decision Records

## Architecture decisions

- **Single canonical product model**: `CanonicalProduct` (spec §10) is the single source of truth; Google and Meta are outputs, not separate pipelines.
- **Language masters + market overrides**: content is authored once per language (FR/DE/EN/IT); markets only override price, availability, URL, shipping, returns.
- **Config in YAML, validated at startup**: all business rules (markets, labels, shipping classes, discount bands) live in versioned YAML files loaded and Zod-validated on boot — fail-fast if config is invalid.
- **Reserved VM for sync worker**: long-running sync jobs and webhook processing use an in-process persistent scheduler with PostgreSQL advisory locks (not Scheduled Deployments).
- **Atomic feed publication**: snapshots are written to a versioned path in Replit App Storage; the `current` pointer is swapped only after validation passes.
- **Dry-run by default**: `GOOGLE_DRY_RUN=true` and `META_DRY_RUN=true` are the defaults — production writes require explicit env override AND `APP_ENV=production`.

## Product

Internal product feed engine for Homestorys (premium furniture, Belgium/France/Germany/Austria). Syncs up to 25,000 product variants across 4 languages and 5 markets from Shopify, enriches them (promotions, image selection, bestsellers, recommendations), and exports to Google Merchant Center and Meta Catalog — replacing Channable without runtime dependency on it.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Config files are at workspace root `config/` — both the API server and scripts navigate to this dir from their `process.cwd()` (api-server: `../../config`, scripts: `../config`).
- The DB schema `product_translations` table is separate from `products` to hold per-language content.
- `SHOPIFY_ADMIN_ACCESS_TOKEN` must never be logged — scope audit logs only names.
- Webhook endpoint requires `express.raw()` before `express.json()` for HMAC validation.
- Run `pnpm --filter @workspace/db run push` after any schema change in `lib/db/src/schema/`.
- The `pnpm bootstrap` script exits non-zero if any required env var is missing but does not hard-crash — check the exit code.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- DB schema: `lib/db/src/schema/index.ts` (exports all 14 tables)
- Config YAML source of truth: `config/`
- .env.example: full annotated env var reference with setup checklist
