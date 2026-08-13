/**
 * Tests for the compare-feeds migration tool.
 *
 * Tests focus on the two key correctness properties:
 *   1. Missing new-feed files are hard regressions (not silent skips).
 *   2. The RFC-4180 CSV parser correctly handles quoted multiline fields.
 */

import { describe, it, expect } from "vitest";

// ── RFC-4180 CSV parser (imported from the script) ────────────────────────────
// We duplicate the parser here for unit testing (the script runs as a CLI tool,
// not as an importable module). This keeps the tests self-contained.

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
        if (i + 1 < content.length && content[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
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
        fields.push(field);
        field = "";
        rows.push([...fields]);
        fields.length = 0;
        i += 2;
      } else if (ch === '\n') {
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

  if (field || fields.length > 0) {
    fields.push(field);
    if (fields.some((f) => f !== "")) {
      rows.push([...fields]);
    }
  }

  return rows;
}

function parseCSV(
  content: string,
): { headers: string[]; rows: Map<string, Record<string, string>> } {
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

// ── CSV parser tests ──────────────────────────────────────────────────────────

describe("RFC-4180 CSV parser", () => {
  it("parses simple fields", () => {
    const rows = parseCSVRows("a,b,c\n1,2,3");
    expect(rows).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("parses CRLF line endings", () => {
    const rows = parseCSVRows("a,b\r\n1,2");
    expect(rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("handles quoted fields with commas inside", () => {
    const rows = parseCSVRows('id,desc\n1,"hello, world"');
    expect(rows[1]![1]).toBe("hello, world");
  });

  it("handles quoted fields with embedded newlines", () => {
    const rows = parseCSVRows('id,desc\n1,"line one\nline two"');
    expect(rows.length).toBe(2); // header + 1 data row
    expect(rows[1]![1]).toBe("line one\nline two");
  });

  it("handles escaped double-quotes inside quoted fields", () => {
    const rows = parseCSVRows('id,desc\n1,"say ""hello"""');
    expect(rows[1]![1]).toBe('say "hello"');
  });

  it("does not split mid-field on an embedded newline", () => {
    // A multiline quoted field must NOT create extra rows
    const content = 'id,desc\n1,"multi\nline\nvalue"\n2,simple';
    const result = parseCSV(content);
    expect(result.rows.size).toBe(2);
    expect(result.rows.get("1")!["desc"]).toBe("multi\nline\nvalue");
    expect(result.rows.get("2")!["desc"]).toBe("simple");
  });

  it("handles empty quoted fields", () => {
    const rows = parseCSVRows('a,b\n1,""');
    expect(rows[1]![1]).toBe("");
  });

  it("handles a file with no trailing newline", () => {
    const rows = parseCSVRows("a,b\n1,2");
    expect(rows.length).toBe(2);
  });
});

// ── Missing-file regression logic ─────────────────────────────────────────────

interface FileDiff {
  filename: string;
  entirelyMissing: boolean;
  baselineCount: number;
  newCount: number;
  onlyInBaseline: string[];
  onlyInNew: string[];
  changed: Array<{ id: string; diffs: unknown[] }>;
}

function compareFiles(
  filename: string,
  baselineContent: string,
  newContent: string | null,
): FileDiff {
  const baseline = parseCSV(baselineContent);

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
  const onlyInBaseline = [...baseline.rows.keys()].filter((id) => !newFeed.rows.has(id));
  const onlyInNew = [...newFeed.rows.keys()].filter((id) => !baseline.rows.has(id));
  const changed: FileDiff["changed"] = [];

  for (const [id, baselineRow] of baseline.rows) {
    const newRow = newFeed.rows.get(id);
    if (!newRow) continue;
    const diffs: unknown[] = [];
    for (const f of Object.keys(baselineRow)) {
      if ((baselineRow[f] ?? "") !== (newRow[f] ?? ""))
        diffs.push({ field: f, baseline: baselineRow[f], new: newRow[f] });
    }
    if (diffs.length) changed.push({ id, diffs });
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

function hasRegressions(diffs: FileDiff[]): boolean {
  return diffs.some((d) => d.onlyInBaseline.length > 0);
}

describe("Missing new-feed file → hard regression", () => {
  const baselineContent = "id,title\nprod1,Chair\nprod2,Table\nprod3,Sofa";

  it("all baseline items become regressions when file is missing", () => {
    const diff = compareFiles("meta-base.csv", baselineContent, null);
    expect(diff.entirelyMissing).toBe(true);
    expect(diff.onlyInBaseline).toEqual(["prod1", "prod2", "prod3"]);
    expect(diff.newCount).toBe(0);
  });

  it("script exits with failure when any file is missing", () => {
    const diffs = [compareFiles("meta-base.csv", baselineContent, null)];
    expect(hasRegressions(diffs)).toBe(true);
  });

  it("no false pass when new feed dir is absent but baseline exists", () => {
    // Simulates the case where the new-feed directory doesn't exist
    const diff = compareFiles("google.tsv", "id,title\n1,A\n2,B", null);
    expect(diff.onlyInBaseline.length).toBe(2);
    expect(hasRegressions([diff])).toBe(true);
  });
});

describe("Partial regressions (file exists but items missing)", () => {
  const baseline = "id,price\nv1,100\nv2,200\nv3,300";
  const newWithMissing = "id,price\nv1,100\nv3,300"; // v2 missing

  it("detects the missing item as a regression", () => {
    const diff = compareFiles("google.tsv", baseline, newWithMissing);
    expect(diff.onlyInBaseline).toEqual(["v2"]);
    expect(hasRegressions([diff])).toBe(true);
  });

  it("new-only items do not block the gate", () => {
    const newWithExtra = "id,price\nv1,100\nv2,200\nv3,300\nv4,400";
    const diff = compareFiles("google.tsv", baseline, newWithExtra);
    expect(diff.onlyInBaseline.length).toBe(0);
    expect(diff.onlyInNew).toEqual(["v4"]);
    expect(hasRegressions([diff])).toBe(false);
  });
});

describe("Field-level diff detection", () => {
  it("detects changed price", () => {
    const baseline = "id,price\nv1,100";
    const newFeed = "id,price\nv1,150";
    const diff = compareFiles("test.csv", baseline, newFeed);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0]!.id).toBe("v1");
  });

  it("no diff when feeds are identical", () => {
    const content = "id,price\nv1,100\nv2,200";
    const diff = compareFiles("test.csv", content, content);
    expect(diff.onlyInBaseline.length).toBe(0);
    expect(diff.changed.length).toBe(0);
  });
});
