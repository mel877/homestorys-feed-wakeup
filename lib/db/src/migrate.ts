/**
 * Database migration runner
 *
 * Applies all pending SQL migrations from lib/db/migrations/ using
 * drizzle-orm's built-in migrator.  Safe to run repeatedly — each migration
 * is tracked in the `drizzle_migrations` table and only applied once.
 *
 * Usage:
 *   pnpm run migrate            (from workspace root)
 *   pnpm --filter @workspace/db run migrate   (from any directory)
 *
 * The script exits 0 on success and 1 on failure, making it suitable for
 * CI / deployment pipelines.
 */

import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("✗ DATABASE_URL is not set — cannot run migrations");
  process.exit(1);
}

const migrationsFolder = path.join(__dirname, "../migrations");

async function main(): Promise<void> {
  console.log("Running database migrations…");
  console.log(`  Migrations folder: ${migrationsFolder}`);

  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    console.log("✓ Migrations applied successfully");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("✗ Migration failed:", err);
  process.exit(1);
});
