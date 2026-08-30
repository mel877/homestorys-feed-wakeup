import type { Readable, Writable } from "node:stream";
import { once } from "node:events";
import {
  createFeedFileWriteStream,
  downloadManifest,
  openFeedFileReadStream,
} from "../../lib/storage";
import { parseDelimitedRecords } from "../../validation/feed-validator";
import {
  META_BASE_HEADERS,
  META_COUNTRY_HEADERS,
  META_LANGUAGE_HEADERS,
  type MetaBaseRow,
  type MetaCountryRow,
  type MetaLanguageRow,
} from "./mapper";

export const META_MARKET_FEEDS = {
  FR: { country: "FR", language: "fr", currency: "EUR" },
  BE_FR: { country: "BE", language: "fr", currency: "EUR" },
  BE_DE: { country: "BE", language: "de", currency: "EUR" },
  DE: { country: "DE", language: "de", currency: "EUR" },
  AT: { country: "AT", language: "de", currency: "EUR" },
  LU_DE: { country: "LU", language: "de", currency: "EUR" },
  CH_FR: { country: "CH", language: "fr", currency: "CHF" },
  CH_DE: { country: "CH", language: "de", currency: "CHF" },
} as const;

export type MetaMarketCode = keyof typeof META_MARKET_FEEDS;
export type MetaMarketRow = MetaBaseRow &
  Omit<MetaLanguageRow, "id"> &
  Omit<MetaCountryRow, "id">;

export const META_MARKET_FEED_HEADERS = [
  ...META_BASE_HEADERS,
  ...META_LANGUAGE_HEADERS.filter((header) => header !== "id"),
  ...META_COUNTRY_HEADERS.filter((header) => header !== "id"),
] as string[];

function indexRows<T extends { id: string }>(
  rows: T[],
  component: string,
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const row of rows) {
    if (indexed.has(row.id)) {
      throw new Error(`${component} contains duplicate id "${row.id}"`);
    }
    indexed.set(row.id, row);
  }
  return indexed;
}

function parseMoney(value: string, field: string, id: string) {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s+([A-Z]{3})$/);
  if (!match) throw new Error(`Invalid ${field} for Meta market id "${id}"`);
  return { amount: Number(match[1]), currency: match[2]! };
}

export function composeMetaMarketRows(input: {
  marketCode: string;
  expectedCurrency: string;
  baseRows: MetaBaseRow[];
  languageRows: MetaLanguageRow[];
  countryRows: MetaCountryRow[];
}): MetaMarketRow[] {
  const bases = indexRows(input.baseRows, "BASE");
  const languages = indexRows(input.languageRows, "LANGUAGE");
  const marketCountryRows = input.countryRows.filter((row) =>
    row.id.endsWith(`_${input.marketCode}`)
  );
  indexRows(marketCountryRows, "COUNTRY");

  return marketCountryRows
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((countryRow) => {
      const baseRow = bases.get(countryRow.id);
      if (!baseRow) {
        throw new Error(`${input.marketCode} id "${countryRow.id}" is missing BASE`);
      }
      const languageRow = languages.get(countryRow.id);
      if (!languageRow) {
        throw new Error(`${input.marketCode} id "${countryRow.id}" is missing LANGUAGE`);
      }
      const price = parseMoney(countryRow.price, "price", countryRow.id);
      if (price.currency !== input.expectedCurrency) {
        throw new Error(
          `${input.marketCode} id "${countryRow.id}" expected ${input.expectedCurrency}, received ${price.currency}`,
        );
      }
      if (countryRow.sale_price.trim()) {
        const salePrice = parseMoney(countryRow.sale_price, "sale_price", countryRow.id);
        if (
          salePrice.currency !== input.expectedCurrency ||
          salePrice.amount >= price.amount
        ) {
          throw new Error(
            `${input.marketCode} id "${countryRow.id}" has invalid sale_price`,
          );
        }
      }
      return {
        ...baseRow,
        ...languageRow,
        ...countryRow,
      };
    });
}

async function readRows<T extends { id: string }>(
  path: string,
  expectedHeaders: readonly string[],
  options: {
    ids?: Set<string>;
    include?: (row: T) => boolean;
  } = {},
): Promise<T[]> {
  const file = await openFeedFileReadStream(path);
  if (!file) throw new Error(`Required Meta component snapshot is missing: ${path}`);
  let headers: string[] | null = null;
  const rows: T[] = [];
  for await (const values of parseDelimitedRecords(file.stream, ",")) {
    if (!headers) {
      headers = values;
      if (headers.join("\u0000") !== expectedHeaders.join("\u0000")) {
        throw new Error(`Unexpected Meta component headers: ${path}`);
      }
      continue;
    }
    const row = Object.fromEntries(headers.map((header, index) => [
      header,
      values[index] ?? "",
    ])) as T;
    if (
      (!options.ids || options.ids.has(row.id)) &&
      (!options.include || options.include(row))
    ) {
      rows.push(row);
    }
  }
  return rows;
}

function serializeLine(row: MetaMarketRow): string {
  return META_MARKET_FEED_HEADERS.map((header) => {
    const value = String(row[header as keyof MetaMarketRow] ?? "");
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join(",") + "\n";
}

async function writeOrWait(stream: Writable, value: string): Promise<void> {
  if (!stream.write(value)) await once(stream, "drain");
}

async function assertComponentManifest(
  path: string,
  syncRunId: string,
  version: string,
): Promise<void> {
  const manifest = await downloadManifest(path);
  if (!manifest) throw new Error(`Required Meta component manifest is missing: ${path}`);
  if (manifest.sourceRunId !== syncRunId || manifest.version !== version) {
    throw new Error(`Meta component snapshot is from a different durable cycle: ${path}`);
  }
}

export async function assembleMetaMarketFeed(input: {
  outputPath: string;
  syncRunId: string;
  version: string;
  marketCode: MetaMarketCode;
  componentPaths: {
    base: string;
    language: string;
    country: string;
  };
}): Promise<{ sha256: string; bytes: number; itemCount: number }> {
  const market = META_MARKET_FEEDS[input.marketCode];
  const {
    base: basePath,
    language: languagePath,
    country: countryPath,
  } = input.componentPaths;
  await Promise.all([
    assertComponentManifest(basePath, input.syncRunId, input.version),
    assertComponentManifest(languagePath, input.syncRunId, input.version),
    assertComponentManifest(countryPath, input.syncRunId, input.version),
  ]);

  const countryRows = await readRows<MetaCountryRow>(
    countryPath,
    META_COUNTRY_HEADERS,
    { include: (row) => row.id.endsWith(`_${input.marketCode}`) },
  );
  const ids = new Set(countryRows.map((row) => row.id));
  const [baseRows, languageRows] = await Promise.all([
    readRows<MetaBaseRow>(basePath, META_BASE_HEADERS, { ids }),
    readRows<MetaLanguageRow>(languagePath, META_LANGUAGE_HEADERS, { ids }),
  ]);
  const rows = composeMetaMarketRows({
    marketCode: input.marketCode,
    expectedCurrency: market.currency,
    baseRows,
    languageRows,
    countryRows,
  });

  const output = createFeedFileWriteStream(input.outputPath, "text/csv", {
    immutable: true,
  });
  const outputStream = output.stream as Writable;
  await writeOrWait(outputStream, META_MARKET_FEED_HEADERS.join(",") + "\n");
  for (const row of rows) await writeOrWait(outputStream, serializeLine(row));
  output.stream.end();
  const stored = await output.done;
  return { ...stored, itemCount: rows.length };
}