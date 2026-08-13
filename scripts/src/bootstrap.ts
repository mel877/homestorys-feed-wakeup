/**
 * Bootstrap script — validates environment and config (via Zod schemas),
 * tests DB connection, and prints a summary of discovered configuration.
 *
 * Designed to fail gracefully:
 * - The DB import is deferred until after the env-var check, so a missing
 *   DATABASE_URL still produces a readable report rather than crashing at startup.
 * - Config is validated through Zod schemas (not just YAML-parsed) so
 *   structurally invalid but parseable configuration is caught and reported.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed (environment, config, or DB)
 *
 * Usage: pnpm --filter @workspace/scripts run bootstrap
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { loadValidatedConfig } from "./config-validator.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// Config dir: scripts/src/ → ../../config/ = workspace root config/
// Override with CONFIG_DIR env var for non-standard layouts.
const CONFIG_DIR =
  process.env["CONFIG_DIR"] ?? resolve(__dir, "../../config");

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(msg: string): void { console.log(`  ✓  ${msg}`); }
function warn(msg: string): void { console.warn(`  ⚠  ${msg}`); }
function fail(msg: string): void { console.error(`  ✗  ${msg}`); }

function checkEnv(name: string, required = true): string | undefined {
  const val = process.env[name];
  if (!val && required) {
    warn(`${name} is not set`);
    return undefined;
  }
  if (val) {
    ok(`${name} is set`);
  } else {
    console.log(`  -  ${name} is not set (optional)`);
  }
  return val;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════");
  console.log("  Homestorys Product Feed Engine — Bootstrap");
  console.log("══════════════════════════════════════════════════\n");

  let hasErrors = false;

  // ── 1. Environment variables ────────────────────────────────────────────────
  console.log("── Environment ──────────────────────────────────");
  const dbUrl = checkEnv("DATABASE_URL");
  checkEnv("SHOPIFY_SHOP_DOMAIN");
  checkEnv("SHOPIFY_ADMIN_ACCESS_TOKEN");
  checkEnv("SHOPIFY_API_VERSION");
  checkEnv("SHOPIFY_WEBHOOK_SECRET");
  checkEnv("GOOGLE_MERCHANT_ACCOUNT_ID", false);
  checkEnv("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64", false);
  checkEnv("META_CATALOG_ID", false);
  checkEnv("META_ACCESS_TOKEN", false);
  checkEnv("INTERNAL_API_SECRET");
  checkEnv("GOOGLE_DRY_RUN", false);
  checkEnv("META_DRY_RUN", false);
  console.log();

  // ── 2. Config validation (Zod — catches structural errors, not just YAML) ──
  console.log("── Configuration (Zod validated) ────────────────");
  let config: ReturnType<typeof loadValidatedConfig> | undefined;
  try {
    config = loadValidatedConfig(CONFIG_DIR);

    const marketCount = Object.keys(config.markets.markets).length;
    ok(`markets.yaml — ${marketCount} markets`);

    const langCount = config.languages.languages.length;
    ok(`languages.yaml — ${langCount} languages`);

    const storeCount = Object.keys(config.stores.stores).length;
    ok(`stores.yaml — ${storeCount} stores`);

    ok("shipping.yaml");
    ok("returns.yaml");

    const catCount = config.categories.mappings.length;
    ok(`categories.yaml — ${catCount} category mappings`);

    ok("labels.yaml");
    ok("complementary.yaml");
    ok("feed-policy.yaml");
  } catch (err) {
    fail(`Config validation failed: ${String(err)}`);
    hasErrors = true;
  }
  console.log();

  // ── 3. Config summaries (only when validation passed) ─────────────────────
  if (config) {
    console.log("── Markets ──────────────────────────────────────");
    for (const [code, market] of Object.entries(config.markets.markets)) {
      console.log(
        `  ${code.padEnd(8)} ${market.country} / ${market.language} / ${market.currency}`,
      );
    }
    console.log();

    console.log("── Languages ────────────────────────────────────");
    for (const lang of config.languages.languages) {
      console.log(`  ${lang.code}  ${lang.name}`);
    }
    console.log();

    console.log("── Stores ───────────────────────────────────────");
    for (const [key, store] of Object.entries(config.stores.stores)) {
      const locationStatus = store.shopify_location_id
        ? `location=${store.shopify_location_id}`
        : "location=NOT SET ← run audit:shopify";
      const codeStatus = store.google_store_code
        ? `store_code=${store.google_store_code}`
        : "store_code=NOT SET";
      console.log(`  ${key}: ${store.name}`);
      console.log(`      ${locationStatus}`);
      console.log(`      ${codeStatus}`);
    }
    console.log();
  }

  // ── 4. JSON schemas on disk ───────────────────────────────────────────────
  console.log("── Schemas ──────────────────────────────────────");
  const schemaDir = resolve(__dir, "../../schemas");
  for (const file of [
    "canonical-product.schema.json",
    "google-product.schema.json",
    "meta-product.schema.json",
  ]) {
    try {
      readFileSync(resolve(schemaDir, file), "utf8");
      ok(file);
    } catch {
      fail(`${file} — not found`);
      hasErrors = true;
    }
  }
  console.log();

  // ── 5. DB connection (deferred until after env check) ─────────────────────
  // Lazy import: importing @workspace/db at the top-level would throw
  // immediately when DATABASE_URL is absent; deferring keeps the error isolated
  // to this section so the rest of the report is still printed.
  console.log("── Database ─────────────────────────────────────");
  if (!dbUrl) {
    fail("DATABASE_URL not set — skipping DB connection test");
    hasErrors = true;
  } else {
    try {
      const { pool } = await import("@workspace/db");
      const client = await pool.connect();
      const result = await client.query<{ now: string }>("SELECT NOW() AS now");
      client.release();
      ok(`Connected to PostgreSQL (${result.rows[0]?.now ?? "unknown"})`);
      await pool.end();
    } catch (err) {
      fail(`DB connection failed: ${String(err)}`);
      hasErrors = true;
    }
  }
  console.log();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════");
  if (hasErrors) {
    fail("Bootstrap completed with errors — review output above");
    console.log("══════════════════════════════════════════════════\n");
    process.exit(1);
  } else {
    ok("Bootstrap completed successfully");
    console.log("══════════════════════════════════════════════════\n");
  }
}

main().catch((err) => {
  console.error("Bootstrap crashed:", err);
  process.exit(1);
});
