import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
// Point to workspace root config/ from artifacts/api-server/tests/
const CONFIG_DIR = resolve(__dir, "../../../config");

// Set CONFIG_DIR before importing the loader
process.env["CONFIG_DIR"] = CONFIG_DIR;

describe("Config loader", () => {
  beforeEach(() => {
    process.env["CONFIG_DIR"] = CONFIG_DIR;
  });

  afterEach(async () => {
    // Reset config cache between tests
    const { resetConfigCache } = await import("../src/config/loader");
    resetConfigCache();
  });

  it("loads all config files without errors", async () => {
    const { loadConfig } = await import("../src/config/loader");
    const config = loadConfig();

    expect(config.markets.markets).toBeDefined();
    expect(config.languages.languages).toBeDefined();
    expect(config.stores.stores).toBeDefined();
    expect(config.shipping.classes).toBeDefined();
    expect(config.returns.classes).toBeDefined();
    expect(config.categories.mappings).toBeDefined();
    expect(config.labels.price_bands).toBeDefined();
    expect(config.feedPolicy.sync_schedule).toBeDefined();
    expect(config.complementary.complementary).toBeDefined();
  });

  it("has all expected markets", async () => {
    const { loadConfig } = await import("../src/config/loader");
    const { markets } = loadConfig().markets;

    expect(markets).toHaveProperty("BE_FR");
    expect(markets).toHaveProperty("BE_DE");
    expect(markets).toHaveProperty("FR");
    expect(markets).toHaveProperty("DE");
    expect(markets).toHaveProperty("AT");
  });

  it("has all expected languages", async () => {
    const { loadConfig } = await import("../src/config/loader");
    const { languages } = loadConfig().languages;

    const codes = languages.map((l) => l.code);
    expect(codes).toContain("fr");
    expect(codes).toContain("de");
    expect(codes).toContain("en");
    expect(codes).toContain("it");
  });

  it("has eupen store configured", async () => {
    const { loadConfig } = await import("../src/config/loader");
    const { stores } = loadConfig().stores;

    expect(stores).toHaveProperty("eupen");
    expect(stores["eupen"]!.name).toBe("Homestorys Eupen");
  });

  it("markets have correct currency EUR", async () => {
    const { loadConfig } = await import("../src/config/loader");
    const { markets } = loadConfig().markets;

    for (const [_code, market] of Object.entries(markets)) {
      expect(market.currency).toBe("EUR");
    }
  });

  it("labels have 5 price bands", async () => {
    const { loadConfig } = await import("../src/config/loader");
    const { price_bands } = loadConfig().labels;

    expect(price_bands).toHaveLength(5);
    expect(price_bands[0]!.key).toBe("0_500");
    expect(price_bands[4]!.key).toBe("5000_plus");
  });

  it("labels have 7 discount buckets", async () => {
    const { loadConfig } = await import("../src/config/loader");
    const { discount_buckets } = loadConfig().labels;

    expect(discount_buckets).toHaveLength(7);
    expect(discount_buckets[0]!.key).toBe("none");
    expect(discount_buckets[6]!.key).toBe("70_plus");
  });

  it("feed policy dry_run defaults to true for both channels", async () => {
    const { loadConfig } = await import("../src/config/loader");
    const { dry_run } = loadConfig().feedPolicy;

    expect(dry_run.google).toBe(true);
    expect(dry_run.meta).toBe(true);
  });

  it("quality weights sum to 100", async () => {
    const { loadConfig } = await import("../src/config/loader");
    const { quality_weights } = loadConfig().feedPolicy;

    const total = Object.values(quality_weights).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });
});
