import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../../.github/workflows/feed-pump.yml", import.meta.url),
  "utf8",
);
const scheduler = readFileSync(
  new URL("../src/jobs/scheduler.ts", import.meta.url),
  "utf8",
);

describe("nightly GitHub workflow", () => {
  it("runs once at 02:00 UTC with explicit non-overlapping concurrency", () => {
    expect(workflow).toContain('cron: "0 2 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: durable-nightly-feed-cycle");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 180");
    expect(workflow).not.toContain("*/30");
  });

  it("advances one protected endpoint sequentially until completion or failure", () => {
    expect(workflow).toContain('while (( SECONDS < deadline ))');
    expect(workflow).toContain('case "$status" in');
    expect(workflow).toContain("NIGHTLY_CYCLE_URL");
    expect(workflow).toContain("Authorization: Bearer $INTERNAL_API_SECRET");
    expect(workflow).not.toContain("&\n");
  });

  it("leaves no competing scheduled Shopify batch or direct export", () => {
    expect(scheduler).not.toContain('name: "full-sync"');
    expect(scheduler).not.toContain('name: "inventory-sync"');
    expect(scheduler).not.toContain('name: "price-sync"');
    expect(scheduler).not.toContain('name: "google-export"');
  });
});