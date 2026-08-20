import type { AppConfig } from "../config/schemas";

function resolveDryRun(envName: "GOOGLE_DRY_RUN" | "META_DRY_RUN", configuredValue: boolean): boolean {
  const value = process.env[envName];
  if (value === undefined) return configuredValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${envName} must be "true" or "false" when set`);
}

export function resolveGoogleDryRun(config: AppConfig): boolean {
  return resolveDryRun("GOOGLE_DRY_RUN", config.feedPolicy.dry_run.google);
}

export function resolveMetaDryRun(config: AppConfig): boolean {
  return resolveDryRun("META_DRY_RUN", config.feedPolicy.dry_run.meta);
}