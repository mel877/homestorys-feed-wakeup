import type { AppConfig } from "../config";

export interface BuildInfo {
  buildVersion: string;
  gitCommit: string;
  swissCurrencyGuard: true;
  marketCurrencies: Record<string, string>;
}

const gitCommit = process.env.BUILD_GIT_COMMIT ?? "development";
const buildVersion =
  process.env.BUILD_VERSION ?? `api-server@${gitCommit.slice(0, 12)}`;

export function getBuildInfo(config: Pick<AppConfig, "markets">): BuildInfo {
  const marketCurrencies = Object.fromEntries(
    Object.entries(config.markets.markets)
      .map(([marketCode, market]) => [marketCode, market.currency])
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    buildVersion,
    gitCommit,
    swissCurrencyGuard: true,
    marketCurrencies,
  };
}