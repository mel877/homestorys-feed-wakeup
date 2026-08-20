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

import { readFileSync } from "fs";
import { resolve, join } from "path";
import type { GoogleFeedRow } from "../exporters/google/mapper";
import type { MetaBaseRow } from "../exporters/meta/mapper";
import { downloadFeedFile, listFeedFiles } from "../lib/storage";
import { logger as rootLogger } from "../lib/logger";

const logger = rootLogger.child({ module: "feed-validator" });

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

// ── TSV parsing ───────────────────────────────────────────────────────────────

function parseTsv(content: string): Record<string, string>[] {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0]!.split("\t");
  return lines.slice(1).map((line) => {
    const values = line.split("\t");
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]!] = values[i]?.replace(/\\t/g, "\t").replace(/\\n/g, "\n") ?? "";
    }
    return row;
  });
}

// ── CSV parsing (RFC-4180 compliant, handles quoted multiline fields) ──────────

/**
 * Full RFC-4180 CSV parser.
 *
 * Scans the entire content character-by-character so quoted fields
 * containing embedded newlines (e.g. product descriptions with \n) are
 * parsed as a single field, not split into multiple malformed rows.
 */
function parseCsv(content: string): Record<string, string>[] {
  // Split content into records (fields across the whole file)
  const records: string[][] = [];
  let currentRecord: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const ch = content[i]!;
    const next = content[i + 1];

    if (inQuotes) {
      if (ch === '"') {
        if (next === '"') {
          // Escaped quote: "" → "
          currentField += '"';
          i += 2;
          continue;
        } else {
          // Closing quote
          inQuotes = false;
        }
      } else {
        // Inside quoted field — accept any character including \n
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRecord.push(currentField);
        currentField = "";
      } else if (ch === '\n') {
        currentRecord.push(currentField);
        currentField = "";
        records.push(currentRecord);
        currentRecord = [];
      } else if (ch === '\r') {
        // Skip CR (handle \r\n as single newline)
        if (next === '\n') {
          i++;
        }
        currentRecord.push(currentField);
        currentField = "";
        records.push(currentRecord);
        currentRecord = [];
      } else {
        currentField += ch;
      }
    }
    i++;
  }
  // Flush final field and record
  if (currentField || currentRecord.length > 0) {
    currentRecord.push(currentField);
    if (currentRecord.some((f) => f !== "")) {
      records.push(currentRecord);
    }
  }

  if (records.length < 2) return [];

  const headers = records[0]!;
  const rows: Record<string, string>[] = [];

  for (let r = 1; r < records.length; r++) {
    const values = records[r]!;
    if (values.every((v) => v === "")) continue; // skip blank rows
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = values[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

/** Minimal RFC-4180 CSV line parser (handles quoted fields with embedded commas). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
    i++;
  }
  fields.push(current);
  return fields;
}
// NOTE: parseCsvLine is kept only for single-line use. The full CSV parser
// (parseCsv) scans character-by-character so it never splits on newlines
// inside quoted fields.

// ── Public API ────────────────────────────────────────────────────────────────

export interface FeedValidationResult {
  file: string;
  rowCount: number;
  errorCount: number;
  errors: ValidationError[];
  valid: boolean;
  schema: string;
}

/**
 * Validate a Google TSV feed file from App Storage.
 * Returns the validation result with all errors.
 */
export async function validateGoogleFeed(storagePath: string): Promise<FeedValidationResult> {
  const buf = await downloadFeedFile(storagePath);
  if (!buf) {
    return { file: storagePath, rowCount: 0, errorCount: 1, errors: [{ row: 0, field: "file", message: "File not found in storage", value: storagePath }], valid: false, schema: "google-product" };
  }

  const schema = loadSchema("google-product") as JsonSchemaNode;
  const rows = parseTsv(buf.toString("utf-8"));
  const allErrors: ValidationError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const errors = validateRow(rows[i]!, schema, i + 2); // +2 for 1-indexed + header row
    allErrors.push(...errors);
  }

  return {
    file: storagePath,
    rowCount: rows.length,
    errorCount: allErrors.length,
    errors: allErrors.slice(0, 200), // cap to 200 for log readability
    valid: allErrors.length === 0,
    schema: "google-product",
  };
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
export async function validateMetaFeed(storagePath: string): Promise<FeedValidationResult> {
  const schemaName = detectMetaSchema(storagePath);

  const buf = await downloadFeedFile(storagePath);
  if (!buf) {
    return { file: storagePath, rowCount: 0, errorCount: 1, errors: [{ row: 0, field: "file", message: "File not found in storage", value: storagePath }], valid: false, schema: schemaName };
  }

  const schema = loadSchema(schemaName) as JsonSchemaNode;
  const rows = parseCsv(buf.toString("utf-8"));
  const allErrors: ValidationError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const errors = validateRow(rows[i]!, schema, i + 2);
    allErrors.push(...errors);
  }

  return {
    file: storagePath,
    rowCount: rows.length,
    errorCount: allErrors.length,
    errors: allErrors.slice(0, 200),
    valid: allErrors.length === 0,
    schema: schemaName,
  };
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
