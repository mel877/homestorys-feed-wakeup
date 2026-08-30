import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../lib/db/migrations/0003_durable_shopify_sync_steps.sql", import.meta.url),
  "utf8",
);

describe("durable Shopify migration", () => {
  it("adds resumable Shopify steps without mutating catalog or snapshots", () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "shopify_sync_steps"');
    expect(migration).toContain('"lease_owner"');
    expect(migration).toContain('"lease_expires_at"');
    expect(migration).toContain('"checkpoint"');
    expect(migration).toContain('"attempts"');
    expect(migration).not.toMatch(/UPDATE\s+"?(products|feed_snapshots|feed_items)/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });
});