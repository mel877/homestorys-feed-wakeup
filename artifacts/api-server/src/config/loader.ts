import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import type { AppConfig } from "./schemas";
import {
  MarketsConfigSchema,
  LanguagesConfigSchema,
  StoresConfigSchema,
  ShippingConfigSchema,
  ReturnsConfigSchema,
  CategoriesConfigSchema,
  LabelsConfigSchema,
  FeedPolicyConfigSchema,
  ComplementaryConfigSchema,
  ExclusionsConfigSchema,
} from "./schemas";

/**
 * Resolve the config directory.
 *
 * When running as the api-server (cwd = artifacts/api-server/),
 * the workspace root config/ is two levels up.
 *
 * Override with CONFIG_DIR env var for non-standard setups.
 */
function resolveConfigDir(): string {
  if (process.env["CONFIG_DIR"]) {
    return process.env["CONFIG_DIR"];
  }
  // In dev (tsx) and prod (bundled), the process cwd is the package dir.
  // From artifacts/api-server/ → ../../config/ = workspace root config/
  return resolve(process.cwd(), "../../config");
}

function loadYaml<T>(
  configDir: string,
  filename: string,
  // biome-ignore format: keep compact
  parse: (raw: unknown) => T,
): T {
  const filePath = resolve(configDir, filename);
  let raw: unknown;
  try {
    const content = readFileSync(filePath, "utf8");
    raw = parseYaml(content);
  } catch (err) {
    throw new Error(
      `Failed to read config file ${filePath}: ${String(err)}`,
    );
  }
  try {
    return parse(raw);
  } catch (err) {
    throw new Error(
      `Config validation failed for ${filename}: ${String(err)}`,
    );
  }
}

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;

  const configDir = resolveConfigDir();

  _config = {
    markets: loadYaml(configDir, "markets.yaml", (raw) =>
      MarketsConfigSchema.parse(raw),
    ),
    languages: loadYaml(configDir, "languages.yaml", (raw) =>
      LanguagesConfigSchema.parse(raw),
    ),
    stores: loadYaml(configDir, "stores.yaml", (raw) =>
      StoresConfigSchema.parse(raw),
    ),
    shipping: loadYaml(configDir, "shipping.yaml", (raw) =>
      ShippingConfigSchema.parse(raw),
    ),
    returns: loadYaml(configDir, "returns.yaml", (raw) =>
      ReturnsConfigSchema.parse(raw),
    ),
    categories: loadYaml(configDir, "categories.yaml", (raw) =>
      CategoriesConfigSchema.parse(raw),
    ),
    labels: loadYaml(configDir, "labels.yaml", (raw) =>
      LabelsConfigSchema.parse(raw),
    ),
    feedPolicy: loadYaml(configDir, "feed-policy.yaml", (raw) =>
      FeedPolicyConfigSchema.parse(raw),
    ),
    complementary: loadYaml(configDir, "complementary.yaml", (raw) =>
      ComplementaryConfigSchema.parse(raw),
    ),
    exclusions: loadYaml(configDir, "exclusions.yaml", (raw) =>
      ExclusionsConfigSchema.parse(raw),
    ),
  };

  return _config;
}

/** Reset config cache — used in tests */
export function resetConfigCache(): void {
  _config = null;
}
