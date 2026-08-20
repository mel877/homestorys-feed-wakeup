import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/schemas";
import { resolveGoogleDryRun, resolveMetaDryRun } from "../src/exporters/dry-run";

const liveByPolicy = {
  feedPolicy: { dry_run: { google: false, meta: false } },
} as AppConfig;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("export dry-run resolution", () => {
  it("uses the configured policy when no environment override exists", () => {
    expect(resolveGoogleDryRun(liveByPolicy)).toBe(false);
    expect(resolveMetaDryRun(liveByPolicy)).toBe(false);
  });

  it("honours true and false environment overrides for both channels", () => {
    vi.stubEnv("GOOGLE_DRY_RUN", "true");
    vi.stubEnv("META_DRY_RUN", "true");
    expect(resolveGoogleDryRun(liveByPolicy)).toBe(true);
    expect(resolveMetaDryRun(liveByPolicy)).toBe(true);

    vi.stubEnv("GOOGLE_DRY_RUN", "false");
    vi.stubEnv("META_DRY_RUN", "false");
    expect(resolveGoogleDryRun(liveByPolicy)).toBe(false);
    expect(resolveMetaDryRun(liveByPolicy)).toBe(false);
  });

  it("rejects ambiguous overrides rather than silently publishing", () => {
    vi.stubEnv("GOOGLE_DRY_RUN", "yes");
    expect(() => resolveGoogleDryRun(liveByPolicy)).toThrow('GOOGLE_DRY_RUN must be "true" or "false"');
  });
});