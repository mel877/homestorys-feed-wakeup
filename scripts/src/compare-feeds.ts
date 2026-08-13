/**
 * Feed comparison script — compares new feed output against a Channable baseline.
 *
 * Reads baseline CSVs from: input/channable-reference/
 * Writes comparison report to: reports/migration-comparison.md
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run compare-feeds
 *   pnpm --filter @workspace/scripts run compare-feeds -- --baseline input/channable-reference --new-feeds output/feeds --report reports/migration-comparison.md
 *
 * REGRESSION POLICY:
 *   - A baseline file with no corresponding new-feed file: ALL baseline items
 *     are treated as regressions. The report section is marked ❌ MISSING.
 *   - A baseline item present in the new feed but with field diffs: counted as
 *     a "changed" row.
 *   - Items in the new feed that aren't in the baseline: counted as "new items".
 *   - Exits 1 if ANY baseline item is absent from the new feed (regression gate).
 *
 * CSV PARSING:
 *   Full RFC-4180 compliant parser — processes the file character-by-character
 *   to correctly handle quoted fields containing commas, newlines, and escaped
 *   double-quotes (""). Does NOT pre-split by newlines.
 */

import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";

const __dir = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dir, "../..");

// ── CLI arg parsing ────────────────────────────────────────────────────────────

function getArg(name: string, defaultValue: string): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === `--${name}` && i + 1 < args.length) return args[i + 1]!;
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return defaultValue;
}

const BASELINE_DIR = resolve(WORKSPACE_ROOT, getArg("baseline", "input/channable-reference"));
const NEW_FEED_DIR = resolve(WORKSPACE_ROOT, getArg("new-feeds", "output/feeds"));
const REPORT_PATH = resolve(WORKSPACE_ROOT, getArg("report", "reports/migration-comparison.md"));
const MAX_DIFF_ROWS = 20;

// ── RFC-4180 compliant CSV parser ──────────────────────────────────────────────

/**
 * Parse CSV content into a list of records.
 *
 * Implements RFC-4180:
 *   - Fields may be enclosed in double-quotes
 *   - Quoted fields may contain commas and CRLF/LF line endings
 *   - A double-quote inside a quoted field is escaped as ""
 *   - Does NOT pre-split by newlines; processes byte-by-byte for correctness
 *
 * Returns: Array of string arrays (one per row, including the header).
 */
function parseCSVRows(content: string): string[][] {
  const rows: string[][] = [];
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const ch = content[i]!;

    if (inQuotes) {
      if (ch === '"') {
        // Lookahead: "" → escaped quote
        if (i + 1 < content.length && content[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        fields.push(field);
        field = "";
        i++;
      } else if (ch === '\r' && i + 1 < content.length && content[i + 1] === '\n') {
        // CRLF
        fields.push(field);
        field = "";
        rows.push([...fields]);
        fields.length = 0;
        i += 2;
      } else if (ch === '\n') {
        // LF-only
        fields.push(field);
        field = "";
        rows.push([...fields]);
        fields.length = 0;
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  // Last field / row (no trailing newline)
  if (field || fields.length > 0) {
    fields.push(field);
    if (fields.some((f) => f !== "")) {
      rows.push([...fields]);
    }
  }

  return rows;
}

/**
 * Parse CSV content into a header array + a Map<id, record>.
 * The first column is used as the record ID.
 */
function parseCSV(content: string): { headers: string[]; rows: Map<string, Record<string, string>> } {
  const allRows = parseCSVRows(content);
  if (allRows.length === 0) return { headers: [], rows: new Map() };

  const headers = allRows[0]!;
  const rows = new Map<string, Record<string, string>>();

  for (let i = 1; i < allRows.length; i++) {
    const values = allRows[i]!;
    const id = values[0] ?? "";
    if (!id) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = values[j] ?? "";
    }
    rows.set(id, row);
  }

  return { headers, rows };
}

// ── Comparison logic ───────────────────────────────────────────────────────────

interface FileDiff {
  filename: string;
  /** True when the new-feed file was entirely absent. */
  entirelyMissing: boolean;
  baselineCount: number;
  newCount: number;
  onlyInBaseline: string[]; // regressions
  onlyInNew: string[];
  changed: Array<{ id: string; diffs: Array<{ field: string; baseline: string; new: string }> }>;
}

function compareFiles(
  filename: string,
  baselineContent: string,
  newContent: string | null,
): FileDiff {
  const baseline = parseCSV(baselineContent);

  // If the new feed file is entirely missing, every baseline item is a regression.
  if (newContent === null) {
    return {
      filename,
      entirelyMissing: true,
      baselineCount: baseline.rows.size,
      newCount: 0,
      onlyInBaseline: Array.from(baseline.rows.keys()),
      onlyInNew: [],
      changed: [],
    };
  }

  const newFeed = parseCSV(newContent);

  const onlyInBaseline: string[] = [];
  const onlyInNew: string[] = [];
  const changed: FileDiff["changed"] = [];

  for (const id of baseline.rows.keys()) {
    if (!newFeed.rows.has(id)) onlyInBaseline.push(id);
  }

  for (const id of newFeed.rows.keys()) {
    if (!baseline.rows.has(id)) onlyInNew.push(id);
  }

  for (const [id, baselineRow] of baseline.rows) {
    const newRow = newFeed.rows.get(id);
    if (!newRow) continue;

    const diffs: FileDiff["changed"][0]["diffs"] = [];
    const allFields = new Set([...Object.keys(baselineRow), ...Object.keys(newRow)]);
    for (const f of allFields) {
      const bVal = baselineRow[f] ?? "";
      const nVal = newRow[f] ?? "";
      if (bVal !== nVal) diffs.push({ field: f, baseline: bVal, new: nVal });
    }
    if (diffs.length > 0) changed.push({ id, diffs });
  }

  return {
    filename,
    entirelyMissing: false,
    baselineCount: baseline.rows.size,
    newCount: newFeed.rows.size,
    onlyInBaseline,
    onlyInNew,
    changed,
  };
}

// ── Report generation ──────────────────────────────────────────────────────────

function renderReport(diffs: FileDiff[]): string {
  const lines: string[] = [
    "# Feed Migration Comparison Report",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Baseline directory: \`${BASELINE_DIR}\``,
    `New feed directory: \`${NEW_FEED_DIR}\``,
    "",
    "## Summary",
    "",
    "| File | Status | Baseline | New | Regressions | New Items | Changed |",
    "|------|--------|----------|-----|-------------|-----------|---------|",
  ];

  let totalRegressions = 0;
  let totalChanged = 0;

  for (const d of diffs) {
    totalRegressions += d.onlyInBaseline.length;
    totalChanged += d.changed.length;
    const fileStatus = d.entirelyMissing
      ? "❌ MISSING"
      : d.onlyInBaseline.length > 0
        ? "❌ REGRESSIONS"
        : d.changed.length > 0
          ? "⚠️ CHANGED"
          : "✅ OK";
    lines.push(
      `| \`${d.filename}\` | ${fileStatus} | ${d.baselineCount} | ${d.entirelyMissing ? "—" : d.newCount} | ` +
        `${d.onlyInBaseline.length} | ${d.onlyInNew.length} | ${d.changed.length} |`,
    );
  }

  const overallStatus =
    totalRegressions === 0 && totalChanged === 0
      ? "✅ **PASS** — no regressions or field differences"
      : totalRegressions > 0
        ? `❌ **FAIL** — ${totalRegressions} item(s) in baseline are missing from the new feed`
        : `⚠️ **REVIEW** — ${totalChanged} changed item(s) detected; no regressions`;

  lines.push("", `**Overall:** ${overallStatus}`, "");

  for (const d of diffs) {
    const sectionStatus = d.entirelyMissing ? " ❌ NEW FEED FILE MISSING" : "";
    lines.push(`## \`${d.filename}\`${sectionStatus}`, "");

    if (d.entirelyMissing) {
      lines.push(
        `> **All ${d.baselineCount} baseline items are regressions** — `,
        `> the new feed file \`${d.filename}\` was not found in \`${NEW_FEED_DIR}\`.`,
        "",
      );
      lines.push("### Regressed Items (first 50)");
      lines.push("```");
      lines.push(...d.onlyInBaseline.slice(0, 50));
      if (d.onlyInBaseline.length > 50) lines.push(`... and ${d.onlyInBaseline.length - 50} more`);
      lines.push("```", "");
      continue;
    }

    if (d.onlyInBaseline.length > 0) {
      lines.push(`### Regressions — ${d.onlyInBaseline.length} item(s) in baseline but missing from new feed`, "");
      lines.push("```");
      lines.push(...d.onlyInBaseline.slice(0, 50));
      if (d.onlyInBaseline.length > 50) lines.push(`... and ${d.onlyInBaseline.length - 50} more`);
      lines.push("```", "");
    }

    if (d.onlyInNew.length > 0) {
      lines.push(`### New Items — ${d.onlyInNew.length} item(s) in new feed but not in baseline`, "");
      lines.push("```");
      lines.push(...d.onlyInNew.slice(0, 50));
      if (d.onlyInNew.length > 50) lines.push(`... and ${d.onlyInNew.length - 50} more`);
      lines.push("```", "");
    }

    if (d.changed.length > 0) {
      lines.push(`### Field Diffs — ${d.changed.length} changed item(s) (first ${MAX_DIFF_ROWS} shown)`, "");
      for (const item of d.changed.slice(0, MAX_DIFF_ROWS)) {
        lines.push(`#### ID: \`${item.id}\``, "");
        lines.push("| Field | Baseline | New Feed |");
        lines.push("|-------|----------|----------|");
        for (const diff of item.diffs) {
          const bEsc = diff.baseline.replace(/\|/g, "\\|").slice(0, 120);
          const nEsc = diff.new.replace(/\|/g, "\\|").slice(0, 120);
          lines.push(`| \`${diff.field}\` | ${bEsc} | ${nEsc} |`);
        }
        lines.push("");
      }
    }

    if (!d.entirelyMissing && d.onlyInBaseline.length === 0 && d.onlyInNew.length === 0 && d.changed.length === 0) {
      lines.push("✅ No differences found.", "");
    }
  }

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Feed comparison script");
  console.log(`Baseline directory: ${BASELINE_DIR}`);
  console.log(`New feed directory: ${NEW_FEED_DIR}`);
  console.log(`Report output: ${REPORT_PATH}`);
  console.log("");

  if (!existsSync(BASELINE_DIR)) {
    console.log(`Baseline directory not found: ${BASELINE_DIR}`);
    console.log("Create this directory and add Channable reference CSV files to use this tool.");
    console.log("Exiting without error — no baseline to compare against.");
    process.exit(0);
  }

  const baselineFiles = readdirSync(BASELINE_DIR).filter((f) => f.endsWith(".csv"));
  if (baselineFiles.length === 0) {
    console.log("No CSV files found in baseline directory.");
    process.exit(0);
  }

  console.log(`Found ${baselineFiles.length} baseline file(s): ${baselineFiles.join(", ")}`);

  if (!existsSync(NEW_FEED_DIR)) {
    console.warn(`New feed directory not found: ${NEW_FEED_DIR}`);
    console.warn("Treating all baseline files as MISSING (all items are regressions).");
  }

  const diffs: FileDiff[] = [];

  for (const filename of baselineFiles) {
    const baselinePath = resolve(BASELINE_DIR, filename);
    const newPath = existsSync(NEW_FEED_DIR) ? resolve(NEW_FEED_DIR, filename) : null;

    const baselineContent = readFileSync(baselinePath, "utf-8");

    // Missing new-feed file → all baseline items are regressions (hard gate)
    const newContent =
      newPath && existsSync(newPath) ? readFileSync(newPath, "utf-8") : null;

    if (!newContent) {
      console.warn(`  ❌ ${filename}: new feed file MISSING — all baseline items are regressions`);
    }

    const diff = compareFiles(filename, baselineContent, newContent);
    diffs.push(diff);

    if (!diff.entirelyMissing) {
      const status =
        diff.onlyInBaseline.length === 0 && diff.changed.length === 0
          ? "✅"
          : diff.onlyInBaseline.length > 0
            ? "❌"
            : "⚠️";
      console.log(
        `  ${status} ${filename}: baseline=${diff.baselineCount} new=${diff.newCount} ` +
          `regressions=${diff.onlyInBaseline.length} new-items=${diff.onlyInNew.length} ` +
          `changed=${diff.changed.length}`,
      );
    }
  }

  // Write report
  const reportDir = dirname(REPORT_PATH);
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const report = renderReport(diffs);
  writeFileSync(REPORT_PATH, report, "utf-8");
  console.log(`\nReport written to: ${REPORT_PATH}`);

  const hasRegressions = diffs.some((d) => d.onlyInBaseline.length > 0);
  if (hasRegressions) {
    console.error("\n❌ FAIL: Regressions detected — some baseline items are missing from the new feed.");
  } else {
    console.log("\n✅ PASS: No regressions detected.");
  }
  process.exit(hasRegressions ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
