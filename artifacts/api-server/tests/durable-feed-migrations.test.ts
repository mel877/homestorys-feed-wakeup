import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../lib/db/migrations/0002_feed_export_source_snapshots.sql", import.meta.url),
  "utf8",
);

describe("durable feed production migrations", () => {
  it("does not mutate existing products, exclusions, configuration, or snapshots", () => {
    expect(migration).not.toMatch(/UPDATE\s+"?(products|feed_snapshots|exclusions|config)/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    expect(migration).toContain("duplicate current snapshots exist");
  });

  it("fails before the current-snapshot uniqueness index when duplicates exist", () => {
    expect(migration.indexOf("duplicate current snapshots exist"))
      .toBeLessThan(migration.indexOf("feed_snapshots_one_current_target_unique"));
  });
});