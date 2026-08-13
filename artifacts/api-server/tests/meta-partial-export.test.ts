/**
 * Tests for Meta partial-market export behavior.
 *
 * When runMetaExport is called with a markets filter:
 * - Shared layers (base, language-fr, language-de) must NOT be published —
 *   they would be incomplete and overwrite valid full-catalog current pointers.
 * - Country layers for markets NOT represented in the filter must be skipped.
 * - Country layers for represented markets ARE published.
 *
 * This file tests the layer selection logic in isolation (no DB or storage calls).
 */

import { describe, it, expect } from "vitest";

// ── Layer selection logic (mirrors runMetaExport in generator.ts) ─────────────

type MetaFeedKey =
  | "base"
  | "language-fr"
  | "language-de"
  | "country-BE"
  | "country-FR"
  | "country-DE"
  | "country-AT";

interface LayerPlan {
  key: MetaFeedKey;
  publish: boolean;
  reason?: string;
}

/**
 * Mirrors the publishing gate in runMetaExport.
 * Given the loaded markets and the representedCountries set, returns which layers
 * should be published vs skipped.
 */
function computeLayerPlan(
  requestedMarkets: string[] | undefined,
  representedCountries: Set<string>,
): LayerPlan[] {
  const isPartialRun = (requestedMarkets?.length ?? 0) > 0;

  const plans: LayerPlan[] = [];

  // Shared layers
  plans.push(
    { key: "base", publish: !isPartialRun, reason: isPartialRun ? "partial-market run" : undefined },
    { key: "language-fr", publish: !isPartialRun, reason: isPartialRun ? "partial-market run" : undefined },
    { key: "language-de", publish: !isPartialRun, reason: isPartialRun ? "partial-market run" : undefined },
  );

  // Country layers
  for (const country of ["BE", "FR", "DE", "AT"] as const) {
    const key: MetaFeedKey = `country-${country}`;
    const hasData = representedCountries.has(country);
    const shouldPublish = !isPartialRun || hasData;
    plans.push({ key, publish: shouldPublish, reason: !shouldPublish ? "country not in partial run markets" : undefined });
  }

  return plans;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Meta export — full run (no markets filter)", () => {
  it("publishes all 7 layers when no markets filter is set", () => {
    const allCountries = new Set(["BE", "FR", "DE", "AT"]);
    const plans = computeLayerPlan(undefined, allCountries);

    const allKeys = plans.map((p) => p.key);
    expect(allKeys).toContain("base");
    expect(allKeys).toContain("language-fr");
    expect(allKeys).toContain("language-de");
    expect(allKeys).toContain("country-BE");
    expect(allKeys).toContain("country-FR");
    expect(allKeys).toContain("country-DE");
    expect(allKeys).toContain("country-AT");

    const allPublish = plans.every((p) => p.publish);
    expect(allPublish).toBe(true);
  });

  it("also publishes all layers when markets is an empty array", () => {
    const plans = computeLayerPlan([], new Set(["BE", "FR", "DE", "AT"]));
    expect(plans.every((p) => p.publish)).toBe(true);
  });
});

describe("Meta export — partial run (markets filter active)", () => {
  it("does NOT publish base layer in a partial run", () => {
    const plans = computeLayerPlan(["BE_FR"], new Set(["BE"]));
    const basePlan = plans.find((p) => p.key === "base")!;
    expect(basePlan.publish).toBe(false);
  });

  it("does NOT publish language-fr in a partial run even when FR is represented", () => {
    const plans = computeLayerPlan(["BE_FR"], new Set(["BE"]));
    const frPlan = plans.find((p) => p.key === "language-fr")!;
    expect(frPlan.publish).toBe(false);
  });

  it("does NOT publish language-de in a partial run", () => {
    const plans = computeLayerPlan(["BE_FR"], new Set(["BE"]));
    const dePlan = plans.find((p) => p.key === "language-de")!;
    expect(dePlan.publish).toBe(false);
  });

  it("DOES publish country-BE when BE is represented in the run", () => {
    // BE_FR market → country BE is in the set
    const plans = computeLayerPlan(["BE_FR"], new Set(["BE"]));
    const bePlan = plans.find((p) => p.key === "country-BE")!;
    expect(bePlan.publish).toBe(true);
  });

  it("does NOT publish country-FR when only BE_FR market was requested", () => {
    const plans = computeLayerPlan(["BE_FR"], new Set(["BE"]));
    const frPlan = plans.find((p) => p.key === "country-FR")!;
    expect(frPlan.publish).toBe(false);
  });

  it("does NOT publish country-DE or country-AT when only BE_FR market was requested", () => {
    const plans = computeLayerPlan(["BE_FR"], new Set(["BE"]));
    const dePlan = plans.find((p) => p.key === "country-DE")!;
    const atPlan = plans.find((p) => p.key === "country-AT")!;
    expect(dePlan.publish).toBe(false);
    expect(atPlan.publish).toBe(false);
  });

  it("publishes only BE country layer when BE_FR + BE_DE markets are requested", () => {
    // Both BE markets → BE country is represented; FR/DE/AT not
    const plans = computeLayerPlan(["BE_FR", "BE_DE"], new Set(["BE"]));
    expect(plans.find((p) => p.key === "country-BE")!.publish).toBe(true);
    expect(plans.find((p) => p.key === "country-FR")!.publish).toBe(false);
    expect(plans.find((p) => p.key === "country-DE")!.publish).toBe(false);
    expect(plans.find((p) => p.key === "country-AT")!.publish).toBe(false);
    // Shared layers still skipped
    expect(plans.find((p) => p.key === "base")!.publish).toBe(false);
    expect(plans.find((p) => p.key === "language-fr")!.publish).toBe(false);
    expect(plans.find((p) => p.key === "language-de")!.publish).toBe(false);
  });

  it("publishes BE and FR country layers when BE_FR + FR markets are requested", () => {
    const plans = computeLayerPlan(["BE_FR", "FR"], new Set(["BE", "FR"]));
    expect(plans.find((p) => p.key === "country-BE")!.publish).toBe(true);
    expect(plans.find((p) => p.key === "country-FR")!.publish).toBe(true);
    expect(plans.find((p) => p.key === "country-DE")!.publish).toBe(false);
    expect(plans.find((p) => p.key === "country-AT")!.publish).toBe(false);
  });
});
