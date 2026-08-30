/**
 * Feed Validator
 *
 * Validates generated feed files against JSON schemas:
 *   schemas/google-product.schema.json
 *   schemas/meta-product.schema.json
 *
 * Used as a gate before atomic publish and available as a standalone CLI
 * command: pnpm feed:validate
 *
 * Parses TSV/CSV from App Storage, samples or validates every row, and
 * reports schema errors with row numbers.
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "path";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { listFeedFiles, openFeedFileReadStream } from "../lib/storage";
import { logger as rootLogger } from "../lib/logger";

const logger = rootLogger.child({ module: "feed-validator" });
const MAX_DELIMITED_FIELD_CHARS = 16 * 1024 * 1024;
const DUPLICATE_ID_PARTITIONS = 64;
const MAX_DUPLICATE_PARTITION_BYTES = 4 * 1024 * 1024;

// ── Schema loading ────────────────────────────────────────────────────────────

type SchemaName =
  | "google-product"
  | "meta-product"
  | "meta-base"
  | "meta-language"
  | "meta-country";

// Find the schemas/ directory relative to the workspace root.
// When running inside artifacts/api-server/ (pnpm run test or node dist/),
// process.cwd() may be the artifact dir; walk up to the monorepo root.
function loadSchema(name: SchemaName): Record<string, unknown> {
  const candidates = [
    // monorepo root when cwd = artifacts/api-server
    resolve(process.cwd(), "../../schemas", `${name}.schema.json`),
    // monorepo root when cwd = monorepo root (prod/CI)
    resolve(process.cwd(), "schemas", `${name}.schema.json`),
    // dist/cli running from inside api-server
    resolve(process.cwd(), "../schemas", `${name}.schema.json`),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  throw new Error(`Schema not found: ${name}. Looked in: ${candidates.join(", ")}`);
}

/**
 * Determine which Meta layer schema to use based on the storage path/filename.
 *
 * meta-base.csv           → meta-base schema (identity + images)
 * meta-language-fr.csv    → meta-language schema (title/desc/link)
 * meta-language-de.csv    → meta-language schema
 * meta-country-BE.csv     → meta-country schema (price/availability)
 * meta-country-FR.csv     → meta-country schema
 * ...
 * anything else           → meta-product schema (full validation)
 */
function detectMetaSchema(storagePath: string): SchemaName {
  const filename = storagePath.split("/").pop() ?? storagePath;
  if (/^meta-base\.csv$/i.test(filename)) return "meta-base";
  if (/^meta-language-[a-z]{2}\.csv$/i.test(filename)) return "meta-language";
  if (/^meta-country-[A-Z]{2}\.csv$/i.test(filename)) return "meta-country";
  return "meta-product"; // fallback: full schema for any full-format files
}

// ── Simple JSON Schema validator (subset: type, enum, pattern, required) ──────
// We avoid adding a heavy dependency (ajv) and cover the subset we actually use.

type JsonSchemaNode = {
  type?: string;
  enum?: string[];
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean;
};

export interface ValidationError {
  row: number;
  field: string;
  message: string;
  value: string;
}

function validateRow(
  row: Record<string, string>,
  schema: JsonSchemaNode,
  rowIndex: number,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const properties = schema.properties ?? {};

  // Check required fields
  for (const field of schema.required ?? []) {
    const value = row[field];
    if (!value || value.trim() === "") {
      errors.push({ row: rowIndex, field, message: "Required field is empty", value: value ?? "" });
    }
  }

  // Validate each known field
  for (const [field, fieldSchema] of Object.entries(properties)) {
    const value = row[field];
    if (!value || value.trim() === "") continue; // empty/missing covered above if required

    if (fieldSchema.enum && !fieldSchema.enum.includes(value)) {
      errors.push({
        row: rowIndex,
        field,
        message: `Value "${value}" not in enum [${fieldSchema.enum.join(", ")}]`,
        value,
      });
    }

    if (fieldSchema.pattern) {
      const re = new RegExp(fieldSchema.pattern);
      if (!re.test(value)) {
        errors.push({
          row: rowIndex,
          field,
          message: `Value "${value.slice(0, 80)}" does not match pattern ${fieldSchema.pattern}`,
          value,
        });
      }
    }

    if (fieldSchema.minLength && value.length < fieldSchema.minLength) {
      errors.push({
        row: rowIndex,
        field,
        message: `Value too short (min ${fieldSchema.minLength})`,
        value,
      });
    }

    if (fieldSchema.maxLength && value.length > fieldSchema.maxLength) {
      errors.push({
        row: rowIndex,
        field,
        message: `Value too long (max ${fieldSchema.maxLength}, got ${value.length})`,
        value: value.slice(0, 100) + "...",
      });
    }
  }

  return errors;
}

/**
 * Build a row validator for a Meta schema without downloading or parsing an
 * entire CSV. Large feeds use this while they are streamed to App Storage.
 */
export function createMetaRowValidator(
  schemaName: "meta-base" | "meta-language" | "meta-country" | "meta-product",
): (row: Record<string, string>, rowIndex: number) => ValidationError[] {
  const schema = loadSchema(schemaName) as JsonSchemaNode;
  return (row, rowIndex) => validateRow(row, schema, rowIndex);
}

// ── Incremental delimited parsing ─────────────────────────────────────────────

class DelimitedParseError extends Error {}

interface TrackedWriter {
  stream: ReturnType<typeof createWriteStream>;
  error: Error | null;
}

function createTrackedWriter(path: string): TrackedWriter {
  const tracked: TrackedWriter = {
    stream: createWriteStream(path, { encoding: "utf8" }),
    error: null,
  };
  tracked.stream.on("error", (error) => {
    tracked.error = error;
  });
  return tracked;
}

async function writeTracked(writer: TrackedWriter, content: string): Promise<void> {
  if (writer.error) throw writer.error;
  if (!writer.stream.write(content)) {
    await once(writer.stream, "drain");
  }
  if (writer.error) throw writer.error;
}

async function closeTracked(writer: TrackedWriter): Promise<void> {
  if (writer.error) throw writer.error;
  await new Promise<void>((resolveEnd, reject) => {
    const handleError = (error: Error) => reject(error);
    writer.stream.once("error", handleError);
    writer.stream.end(() => {
      writer.stream.off("error", handleError);
      if (writer.error) reject(writer.error);
      else resolveEnd();
    });
  });
}

async function* parseDelimitedRecords(
  stream: Readable,
  delimiter: "," | "\t",
): AsyncGenerator<string[]> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let currentRecord: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let afterQuote = false;
  let skipLineFeed = false;

  const parseChunk = (content: string): string[][] => {
    const completed: string[][] = [];
    const finishRecord = () => {
      currentRecord.push(currentField);
      currentField = "";
      completed.push(currentRecord);
      currentRecord = [];
    };

    for (const ch of content) {
      if (skipLineFeed) {
        skipLineFeed = false;
        if (ch === "\n") continue;
      }

      if (delimiter === "," && inQuotes) {
        if (ch === '"') {
          inQuotes = false;
          afterQuote = true;
        } else {
          currentField += ch;
        }
        if (currentField.length > MAX_DELIMITED_FIELD_CHARS) {
          throw new DelimitedParseError("Delimited field exceeds maximum supported size");
        }
        continue;
      }

      if (delimiter === "," && afterQuote) {
        if (ch === '"') {
          currentField += '"';
          if (currentField.length > MAX_DELIMITED_FIELD_CHARS) {
            throw new DelimitedParseError("Delimited field exceeds maximum supported size");
          }
          inQuotes = true;
          afterQuote = false;
          continue;
        }
        afterQuote = false;
        if (ch !== delimiter && ch !== "\n" && ch !== "\r") {
          throw new DelimitedParseError("Unexpected character after closing CSV quote");
        }
      }

      if (delimiter === "," && ch === '"') {
        if (currentField.length > 0) {
          throw new DelimitedParseError("Unexpected CSV quote in unquoted field");
        }
        inQuotes = true;
      } else if (ch === delimiter) {
        currentRecord.push(currentField);
        currentField = "";
      } else if (ch === "\n") {
        finishRecord();
      } else if (ch === "\r") {
        finishRecord();
        skipLineFeed = true;
      } else {
        currentField += ch;
        if (currentField.length > MAX_DELIMITED_FIELD_CHARS) {
          throw new DelimitedParseError("Delimited field exceeds maximum supported size");
        }
      }
    }
    return completed;
  };

  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const record of parseChunk(decoder.decode(bytes, { stream: true }))) {
      yield record;
    }
  }
  for (const record of parseChunk(decoder.decode())) {
    yield record;
  }
  if (inQuotes) {
    throw new DelimitedParseError("CSV quoted field is not terminated");
  }
  if (currentField || currentRecord.length > 0) {
    currentRecord.push(currentField);
    if (currentRecord.some((field) => field !== "")) {
      yield currentRecord;
    }
  }
}

class ExactDuplicateIdTracker {
  private readonly directory: string;
  private readonly paths: string[];
  private readonly writers: TrackedWriter[];
  private writersClosed = false;

  private constructor(directory: string) {
    this.directory = directory;
    this.paths = Array.from(
      { length: DUPLICATE_ID_PARTITIONS },
      (_, index) => resolve(directory, `${String(index).padStart(2, "0")}.jsonl`),
    );
    this.writers = this.paths.map(createTrackedWriter);
  }

  static async create(): Promise<ExactDuplicateIdTracker> {
    return new ExactDuplicateIdTracker(
      await mkdtemp(resolve(tmpdir(), "feed-validator-ids-")),
    );
  }

  async add(id: string, row: number): Promise<void> {
    const partition = createHash("sha256").update(id).digest()[0]! %
      DUPLICATE_ID_PARTITIONS;
    const writer = this.writers[partition]!;
    await writeTracked(writer, `${JSON.stringify([id, row])}\n`);
  }

  async findDuplicates(
    onDuplicate: (error: ValidationError) => void,
  ): Promise<void> {
    await this.closeWriters();
    try {
      for (const path of this.paths) {
        await this.scanPartition(path, 1, onDuplicate);
      }
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  async dispose(): Promise<void> {
    await this.closeWriters();
    await rm(this.directory, { recursive: true, force: true });
  }

  private async closeWriters(): Promise<void> {
    if (this.writersClosed) return;
    this.writersClosed = true;
    await Promise.all(this.writers.map(closeTracked));
  }

  private async scanPartition(
    path: string,
    hashByte: number,
    onDuplicate: (error: ValidationError) => void,
  ): Promise<void> {
    const metadata = await stat(path);
    if (metadata.size <= MAX_DUPLICATE_PARTITION_BYTES || hashByte >= 32) {
      const seen = new Set<string>();
      const lines = createInterface({
        input: createReadStream(path),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line) continue;
        const [id, row] = JSON.parse(line) as [string, number];
        if (seen.has(id)) {
          onDuplicate({
            row,
            field: "id",
            message: `Duplicate ID "${id}"`,
            value: id,
          });
        } else {
          seen.add(id);
        }
      }
      return;
    }

    const partitionDirectory = `${path}.partitions-${hashByte}`;
    await mkdir(partitionDirectory);
    const paths = Array.from(
      { length: DUPLICATE_ID_PARTITIONS },
      (_, index) => resolve(partitionDirectory, `${String(index).padStart(2, "0")}.jsonl`),
    );
    const writers = paths.map(createTrackedWriter);
    try {
      const lines = createInterface({
        input: createReadStream(path),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line) continue;
        const [id] = JSON.parse(line) as [string, number];
        const partition = createHash("sha256").update(id).digest()[hashByte]! %
          DUPLICATE_ID_PARTITIONS;
        const writer = writers[partition]!;
        await writeTracked(writer, `${line}\n`);
      }
      await Promise.all(writers.map(closeTracked));
      await rm(path, { force: true });
      for (const partitionPath of paths) {
        await this.scanPartition(partitionPath, hashByte + 1, onDuplicate);
      }
    } finally {
      for (const writer of writers) {
        if (!writer.stream.closed) writer.stream.destroy();
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FeedValidationResult {
  file: string;
  rowCount: number;
  errorCount: number;
  errors: ValidationError[];
  valid: boolean;
  schema: string;
}

export interface FeedValidationOptions {
  expectedCurrency?: string;
}

function findUnexpectedCurrenciesInRow(
  row: Record<string, string>,
  rowIndex: number,
  expectedCurrency: string | undefined,
): ValidationError[] {
  if (!expectedCurrency) return [];

  const errors: ValidationError[] = [];
  const currencyFields = ["price", "sale_price", "shipping"];
  for (const field of currencyFields) {
    const value = row[field]?.trim();
    if (!value) continue;
    const currency = value.match(/\b([A-Z]{3})$/)?.[1];
    if (currency && currency !== expectedCurrency) {
      errors.push({
        row: rowIndex,
        field,
        message: `Expected currency ${expectedCurrency}, received ${currency}`,
        value,
      });
    }
  }
  return errors;
}

function parseMoney(value: string | undefined): {
  amount: number;
  currency: string;
} | null {
  const match = value?.trim().match(/^(-?\d+(?:\.\d+)?)\s+([A-Z]{3})$/);
  if (!match) return null;
  return {
    amount: Number(match[1]),
    currency: match[2]!,
  };
}

function findInvalidPromotionInRow(
  row: Record<string, string>,
  rowIndex: number,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const rawSalePrice = row["sale_price"]?.trim();
  if (!rawSalePrice) return errors;

  const price = parseMoney(row["price"]);
  const salePrice = parseMoney(rawSalePrice);
  if (!price || !salePrice) return errors;

  if (price.currency !== salePrice.currency) {
    errors.push({
      row: rowIndex,
      field: "sale_price",
      message: `Sale price currency ${salePrice.currency} must match price currency ${price.currency}`,
      value: rawSalePrice,
    });
    return errors;
  }

  if (salePrice.amount >= price.amount) {
    errors.push({
      row: rowIndex,
      field: "sale_price",
      message: "Sale price must be strictly lower than price",
      value: rawSalePrice,
    });
  }
  return errors;
}

async function validateFeedStream(input: {
  storagePath: string;
  schemaName: SchemaName;
  delimiter: "," | "\t";
  expectedCurrency?: string;
}): Promise<FeedValidationResult> {
  const file = await openFeedFileReadStream(input.storagePath);
  if (!file) {
    return {
      file: input.storagePath,
      rowCount: 0,
      errorCount: 1,
      errors: [{
        row: 0,
        field: "file",
        message: "File not found in storage",
        value: input.storagePath,
      }],
      valid: false,
      schema: input.schemaName,
    };
  }

  const schema = loadSchema(input.schemaName) as JsonSchemaNode;
  const duplicateIds = await ExactDuplicateIdTracker.create();
  const errors: ValidationError[] = [];
  let errorCount = 0;
  let rowCount = 0;
  let headers: string[] | null = null;

  const addErrors = (newErrors: ValidationError[]) => {
    errorCount += newErrors.length;
    if (errors.length < 200) {
      errors.push(...newErrors.slice(0, 200 - errors.length));
    }
  };

  try {
    for await (const values of parseDelimitedRecords(file.stream, input.delimiter)) {
      if (!headers) {
        if (values.every((value) => value === "")) continue;
        headers = values;
        continue;
      }
      if (values.every((value) => value === "")) continue;

      rowCount++;
      const rowIndex = rowCount + 1;
      const row: Record<string, string> = {};
      for (let index = 0; index < headers.length; index++) {
        const value = values[index] ?? "";
        row[headers[index]!] = input.delimiter === "\t"
          ? value.replace(/\\t/g, "\t").replace(/\\n/g, "\n")
          : value;
      }

      const id = row["id"]?.trim();
      if (id) {
        await duplicateIds.add(id, rowIndex);
      }
      addErrors(findUnexpectedCurrenciesInRow(row, rowIndex, input.expectedCurrency));
      addErrors(findInvalidPromotionInRow(row, rowIndex));
      addErrors(validateRow(row, schema, rowIndex));
    }
    await duplicateIds.findDuplicates((error) => addErrors([error]));
  } catch (error) {
    file.stream.destroy();
    await duplicateIds.dispose();
    if (
      error instanceof TypeError &&
      (error as NodeJS.ErrnoException).code === "ERR_ENCODING_INVALID_ENCODED_DATA"
    ) {
      return {
        file: input.storagePath,
        rowCount: 0,
        errorCount: 1,
        errors: [{
          row: 0,
          field: "encoding",
          message: "File is not valid UTF-8",
          value: input.storagePath,
        }],
        valid: false,
        schema: input.schemaName,
      };
    }
    if (error instanceof DelimitedParseError) {
      addErrors([{
        row: rowCount + 2,
        field: "csv",
        message: error.message,
        value: input.storagePath,
      }]);
      return {
        file: input.storagePath,
        rowCount,
        errorCount,
        errors,
        valid: false,
        schema: input.schemaName,
      };
    }
    throw error;
  }

  return {
    file: input.storagePath,
    rowCount,
    errorCount,
    errors,
    valid: errorCount === 0,
    schema: input.schemaName,
  };
}

/**
 * Validate a Google TSV feed file from App Storage.
 * Returns the validation result with all errors.
 */
export async function validateGoogleFeed(
  storagePath: string,
  options: FeedValidationOptions = {},
): Promise<FeedValidationResult> {
  return validateFeedStream({
    storagePath,
    schemaName: "google-product",
    delimiter: "\t",
    expectedCurrency: options.expectedCurrency,
  });
}

/**
 * Validate a Meta CSV feed file from App Storage.
 *
 * Automatically selects the correct layer schema based on the filename:
 *   meta-base.csv         → meta-base schema
 *   meta-language-*.csv   → meta-language schema
 *   meta-country-*.csv    → meta-country schema
 *   anything else         → meta-product schema (full)
 */
export async function validateMetaFeed(
  storagePath: string,
  options: FeedValidationOptions = {},
): Promise<FeedValidationResult> {
  const schemaName = detectMetaSchema(storagePath);
  return validateFeedStream({
    storagePath,
    schemaName,
    delimiter: ",",
    expectedCurrency: options.expectedCurrency,
  });
}

/**
 * Validate all current feed files in App Storage.
 * Lists all files under feeds/ and validates by extension/channel.
 */
export async function validateAllFeeds(): Promise<{
  results: FeedValidationResult[];
  totalErrors: number;
  valid: boolean;
}> {
  const googleFiles = await listFeedFiles("feeds/google/").then((files) =>
    files.filter((f) => f.endsWith(".tsv") && !f.includes("/versions/")),
  );
  const metaFiles = await listFeedFiles("feeds/meta/").then((files) =>
    files.filter((f) => f.endsWith(".csv") && !f.includes("/versions/")),
  );

  logger.info({ googleFiles: googleFiles.length, metaFiles: metaFiles.length }, "Validating all feeds");

  const results = await Promise.all([
    ...googleFiles.map((f) => validateGoogleFeed(f)),
    ...metaFiles.map((f) => validateMetaFeed(f)),
  ]);

  const totalErrors = results.reduce((s, r) => s + r.errorCount, 0);
  const valid = results.every((r) => r.valid);

  return { results, totalErrors, valid };
}
