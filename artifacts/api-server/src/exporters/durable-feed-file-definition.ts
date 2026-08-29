import {
  googleFeedPath,
  googleLanguageFeedPath,
  metaFeedPath,
  versionedPath,
} from "../lib/storage";
import { GOOGLE_TSV_HEADERS } from "./google/mapper";
import {
  META_BASE_HEADERS,
  META_COUNTRY_HEADERS,
  META_LANGUAGE_HEADERS,
} from "./meta/mapper";

export interface DurableFeedFileDefinitionInput {
  channel: "google" | "meta";
  fileKey: string;
  version: string;
  language: string;
  marketCode: string;
}

export interface DurableFeedFileDefinition {
  currentPath: string;
  versionedPath: string;
  headers: string[];
  delimiter: "," | "\t";
  expectedCurrencyMarket: string | null;
}

export function resolveExpectedFeedCurrency(
  markets: Record<string, { currency: string }>,
  contributingMarkets: string[],
): string {
  const configured = contributingMarkets.map(
    (marketCode) => markets[marketCode]?.currency,
  );
  if (configured.some((currency) => currency === undefined) || configured.length === 0) {
    throw new Error("Missing configured currency for a contributing market");
  }
  const currencies = new Set(configured as string[]);
  if (currencies.size !== 1) {
    throw new Error("Conflicting configured currencies for a shared feed file");
  }
  return currencies.values().next().value as string;
}

export function resolveDurableFeedFileDefinition(
  input: DurableFeedFileDefinitionInput,
): DurableFeedFileDefinition {
  if (input.channel === "google") {
    const languageFile = input.fileKey.startsWith("google-language-");
    const currentPath = languageFile
      ? googleLanguageFeedPath(input.language)
      : googleFeedPath(input.language, input.marketCode);
    return {
      currentPath,
      versionedPath: versionedPath(currentPath, input.version),
      headers: [...GOOGLE_TSV_HEADERS],
      delimiter: "\t",
      expectedCurrencyMarket: languageFile ? null : input.marketCode,
    };
  }

  let filename: string;
  let headers: string[];
  let expectedCurrencyMarket: string | null = null;
  if (input.fileKey === "meta-base") {
    filename = "meta-base.csv";
    headers = [...META_BASE_HEADERS];
  } else if (input.fileKey.startsWith("meta-language-")) {
    filename = `${input.fileKey}.csv`;
    headers = [...META_LANGUAGE_HEADERS];
  } else if (input.fileKey.startsWith("meta-country-")) {
    filename = `${input.fileKey}.csv`;
    headers = [...META_COUNTRY_HEADERS];
    expectedCurrencyMarket = input.marketCode;
  } else {
    throw new Error(`Unsupported durable feed file key: ${input.fileKey}`);
  }
  const currentPath = metaFeedPath(filename);
  return {
    currentPath,
    versionedPath: versionedPath(currentPath, input.version),
    headers,
    delimiter: ",",
    expectedCurrencyMarket,
  };
}