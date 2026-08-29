import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  createFeedFileWriteStream,
  openFeedFileReadStream,
} from "../lib/storage";

export interface CompletedFeedPart {
  batchIndex: number;
  artifactPath: string;
  status: string;
}

export interface FeedPartStorage {
  openPart(path: string): Promise<Readable | null>;
  createOutput(
    path: string,
    contentType: "text/csv" | "text/tab-separated-values",
    immutable?: boolean,
  ): {
    stream: Writable;
    done: Promise<{ sha256: string; bytes: number }>;
  };
}

export interface AssembleVersionedFeedOptions {
  outputPath: string;
  headers: string[];
  delimiter: "," | "\t";
  requiredBatchIndexes: number[];
  parts: CompletedFeedPart[];
  immutableOutput?: boolean;
  storage?: FeedPartStorage;
}

export function deterministicFeedPartPath(
  versionedFeedPath: string,
  batchIndex: number,
): string {
  if (!Number.isInteger(batchIndex) || batchIndex < 0) {
    throw new Error("Feed batch index must be a non-negative integer");
  }
  return `${versionedFeedPath}.parts/${String(batchIndex).padStart(6, "0")}.jsonl`;
}

export function serializeFeedPart(
  rows: Array<Record<string, unknown>>,
): string {
  return [...rows]
    .sort((a, b) => String(a["id"] ?? "").localeCompare(String(b["id"] ?? "")))
    .map((row) => JSON.stringify(row))
    .join("\n") + (rows.length > 0 ? "\n" : "");
}

export async function assembleVersionedFeed(
  options: AssembleVersionedFeedOptions,
): Promise<{ sha256: string; bytes: number; itemCount: number }> {
  const required = [...new Set(options.requiredBatchIndexes)].sort((a, b) => a - b);
  const completeByIndex = new Map(
    options.parts
      .filter((part) => part.status === "completed" && part.artifactPath)
      .map((part) => [part.batchIndex, part]),
  );
  if (
    required.length === 0 ||
    required.some((batchIndex) => !completeByIndex.has(batchIndex))
  ) {
    throw new Error("Feed finalization barrier is closed: required batches are incomplete");
  }

  const storage = options.storage ?? defaultStorage;
  const contentType = options.delimiter === "\t"
    ? "text/tab-separated-values"
    : "text/csv";
  const output = storage.createOutput(
    options.outputPath,
    contentType,
    options.immutableOutput,
  );
  await writeOrWait(output.stream, serializeLine(options.headers, options.delimiter));

  let itemCount = 0;
  for (const batchIndex of required) {
    const part = completeByIndex.get(batchIndex)!;
    const stream = await storage.openPart(part.artifactPath);
    if (!stream) {
      throw new Error(`Feed part is missing from storage: ${part.artifactPath}`);
    }
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      await writeOrWait(
        output.stream,
        serializeLine(
          options.headers.map((header) => String(row[header] ?? "")),
          options.delimiter,
        ),
      );
      itemCount++;
    }
  }

  output.stream.end();
  const result = await output.done;
  return { ...result, itemCount };
}

function serializeLine(values: string[], delimiter: "," | "\t"): string {
  return values.map((value) => {
    if (delimiter === "\t") {
      return value.replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "");
    }
    if (/[",\r\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }).join(delimiter) + "\n";
}

async function writeOrWait(stream: Writable, content: string): Promise<void> {
  if (!stream.write(content)) {
    await once(stream, "drain");
  }
}

const defaultStorage: FeedPartStorage = {
  async openPart(path) {
    const file = await openFeedFileReadStream(path);
    return file?.stream ?? null;
  },
  createOutput(path, contentType, immutable) {
    return createFeedFileWriteStream(path, contentType, { immutable }) as {
      stream: Writable;
      done: Promise<{ sha256: string; bytes: number }>;
    };
  },
};