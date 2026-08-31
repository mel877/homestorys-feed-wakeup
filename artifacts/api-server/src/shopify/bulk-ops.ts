/**
 * Shopify Bulk Operations utilities.
 *
 * Bulk Operations allow fetching large datasets (entire product catalog)
 * via a JSONL file. The flow is:
 * 1. Submit a `bulkOperationRunQuery` mutation
 * 2. Poll `currentBulkOperation` until status is COMPLETED or FAILED
 * 3. Download the JSONL from the signed `url`
 * 4. Parse each line (child nodes have a `__parentId` field)
 */

import { logger as rootLogger } from "../lib/logger";
import type { ShopifyClient } from "./client";
import type { BulkNode, BulkOperation, BulkOperationStatus } from "./types";
import { sleep } from "./client";

const logger = rootLogger.child({ module: "shopify-bulk-ops" });

export interface BulkJsonlLine<T> {
  value: T;
  startOffset: number;
  endOffset: number;
}

/** Read only a bounded prefix of a bulk result.  Offsets are byte offsets in
 * the original UTF-8 object and consequently can be used directly in HTTP
 * Range requests after a crash. */
export async function readBulkJsonlSlice<T>(
  url: string,
  options: {
    offset?: number;
    maxLines?: number;
    shouldContinue?: () => boolean | Promise<boolean>;
    fetcher?: typeof fetch;
  } = {},
): Promise<{ lines: BulkJsonlLine<T>[]; nextOffset: number; eof: boolean }> {
  const offset = options.offset ?? 0;
  const maxLines = options.maxLines ?? 100;
  const fetcher = options.fetcher ?? fetch;
  if (options.shouldContinue && !await options.shouldContinue()) {
    return { lines: [], nextOffset: offset, eof: false };
  }
  const response = await fetcher(url, {
    headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined,
  });
  if (offset === 0 ? response.status !== 200 : response.status !== 206) {
    throw new Error(`Bulk range download at offset ${offset} requires HTTP ${offset === 0 ? 200 : 206}; got ${response.status}`);
  }
  if (!response.body) throw new Error("Bulk results response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let pending = new Uint8Array();
  let pendingOffset = offset;
  let lastCompleteOffset = offset;
  let eof = false;
  const lines: BulkJsonlLine<T>[] = [];
  try {
    while (lines.length < maxLines && await (options.shouldContinue?.() ?? true)) {
      const { done, value } = await reader.read();
      if (done) {
        eof = true;
        if (pending.length > 0 && lines.length < maxLines) {
          const startOffset = pendingOffset;
          const endOffset = pendingOffset + pending.length;
          try {
            lines.push({
              value: JSON.parse(decoder.decode(pending)) as T,
              startOffset,
              endOffset,
            });
            lastCompleteOffset = endOffset;
          } catch {
            logger.warn({ offset: startOffset }, "Failed to parse final JSONL line");
            lastCompleteOffset = endOffset;
          }
        }
        break;
      }
      const joined = new Uint8Array(pending.length + value.length);
      joined.set(pending);
      joined.set(value, pending.length);
      let lineStart = 0;
      for (let i = 0; i < joined.length && lines.length < maxLines; i++) {
        if (joined[i] !== 10) continue;
        const lineBytes = joined.slice(lineStart, i);
        const startOffset = pendingOffset + lineStart;
        const endOffset = pendingOffset + i + 1;
        lineStart = i + 1;
        lastCompleteOffset = endOffset;
        if (lineBytes.length === 0) continue;
        try {
          lines.push({ value: JSON.parse(decoder.decode(lineBytes)) as T, startOffset, endOffset });
        } catch {
          logger.warn({ offset: startOffset }, "Failed to parse JSONL line — skipping");
        }
      }
      if (lines.length >= maxLines) {
        // Do not retain data read ahead from this chunk: the next range starts
        // at the last committed newline and safely replays only uncommitted data.
        break;
      }
      pending = joined.slice(lineStart);
      pendingOffset += lineStart;
    }
  } finally {
    if (!eof) await reader.cancel();
    reader.releaseLock();
  }
  return {
    lines,
    // Bad/blank complete lines are also safely consumed; otherwise a malformed
    // line would make a resumed worker retry the same byte range forever.
    nextOffset: lastCompleteOffset,
    eof,
  };
}

// ── GraphQL fragments ─────────────────────────────────────────────────────────

const BULK_OPERATION_FIELDS = `
  id
  status
  errorCode
  url
  objectCount
  fileSize
  createdAt
  completedAt
  query
`;

const CREATE_BULK_OPERATION = `
  mutation BulkOperationRunQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { ${BULK_OPERATION_FIELDS} }
      userErrors { field message }
    }
  }
`;

const POLL_BULK_OPERATION = `
  query CurrentBulkOperation {
    currentBulkOperation { ${BULK_OPERATION_FIELDS} }
  }
`;
const GET_BULK_OPERATION = `
  query BulkOperation($id: ID!) {
    node(id: $id) {
      ... on BulkOperation { ${BULK_OPERATION_FIELDS} }
    }
  }
`;

/** Read the current bulk operation exactly once.  Durable workers must use this
 * instead of pollBulkOperation, which intentionally waits between requests. */
export async function getCurrentBulkOperation(
  client: ShopifyClient,
): Promise<BulkOperation | null> {
  const result = await client.request<{ currentBulkOperation: BulkOperation | null }>(
    POLL_BULK_OPERATION,
    {},
    { expectedCost: 1 },
  );
  return result.currentBulkOperation;
}

/** Fetch the operation we persisted, rather than treating an unrelated current
 * operation as ours. */
export async function getBulkOperationById(
  client: ShopifyClient,
  id: string,
): Promise<BulkOperation | null> {
  const result = await client.request<{ node: BulkOperation | null }>(
    GET_BULK_OPERATION, { id }, { expectedCost: 1 },
  );
  return result.node;
}

export function normalizeBulkQuery(query: string): string {
  return query.replace(/#[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

const CANCEL_BULK_OPERATION = `
  mutation BulkOperationCancel($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

// ── Terminal statuses ─────────────────────────────────────────────────────────

const TERMINAL: Set<BulkOperationStatus> = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "EXPIRED",
]);

export const SHOPIFY_PRODUCTS_BULK_CONTENTION_ERROR =
  "Cannot create products bulk operation: an unrelated Shopify bulk operation is active";
export const SHOPIFY_BULK_CONTENTION_ERROR =
  "Cannot create inventory bulk operation: an unrelated Shopify bulk operation is active";

export type CurrentBulkOperationDecision = "adopt" | "block" | "create";

export function decideCurrentBulkOperation(
  current: BulkOperation | null,
  expectedQuery: string,
): CurrentBulkOperationDecision {
  if (!current) return "create";
  if (normalizeBulkQuery(current.query ?? "") === normalizeBulkQuery(expectedQuery)) {
    return "adopt";
  }
  return TERMINAL.has(current.status) ? "create" : "block";
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Submit a bulk operation. Returns the operation ID.
 * Throws if another bulk operation is already running (Shopify allows only one at a time).
 */
export async function createBulkOperation(
  client: ShopifyClient,
  query: string,
): Promise<string> {
  const result = await client.request<{
    bulkOperationRunQuery: {
      bulkOperation: BulkOperation | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(CREATE_BULK_OPERATION, { query }, { expectedCost: 10 });

  const { bulkOperation, userErrors } = result.bulkOperationRunQuery;

  if (userErrors.length > 0) {
    const messages = userErrors.map((e) => `${e.field.join(".")}: ${e.message}`).join("; ");
    throw new Error(`Bulk operation creation failed: ${messages}`);
  }

  if (!bulkOperation) {
    throw new Error("Bulk operation creation returned no operation");
  }

  logger.info({ operationId: bulkOperation.id, status: bulkOperation.status }, "Bulk operation created");
  return bulkOperation.id;
}

/**
 * Poll a bulk operation until it reaches a terminal status.
 * Returns the completed operation metadata.
 *
 * @param pollIntervalMs - Time between polls (default 4s, increased for large ops)
 * @param timeoutMs - Give up after this many ms (default 30 minutes)
 */
export async function pollBulkOperation(
  client: ShopifyClient,
  _operationId: string,
  pollIntervalMs = 4_000,
  timeoutMs = 30 * 60 * 1000,
): Promise<BulkOperation> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    await sleep(pollIntervalMs);

    const result = await client.request<{
      currentBulkOperation: BulkOperation | null;
    }>(POLL_BULK_OPERATION, {}, { expectedCost: 1 });

    const op = result.currentBulkOperation;
    if (!op) {
      throw new Error("No current bulk operation found");
    }

    logger.debug(
      { status: op.status, objectCount: op.objectCount },
      "Bulk operation polling",
    );

    if (TERMINAL.has(op.status)) {
      if (op.status === "FAILED") {
        throw new Error(`Bulk operation failed: ${op.errorCode ?? "unknown"}`);
      }
      if (op.status === "CANCELED" || op.status === "EXPIRED") {
        throw new Error(`Bulk operation ended with status: ${op.status}`);
      }

      logger.info(
        {
          objectCount: op.objectCount,
          fileSize: op.fileSize,
          completedAt: op.completedAt,
        },
        "Bulk operation completed",
      );
      return op;
    }

    // Back off polling interval on long-running operations
    if (Date.now() - startTime > 5 * 60 * 1000) {
      pollIntervalMs = Math.min(pollIntervalMs * 1.5, 30_000);
    }
  }

  throw new Error(`Bulk operation timed out after ${timeoutMs}ms`);
}

/**
 * Download and stream bulk operation results as parsed JSONL nodes.
 * Each node is a raw JS object; children have `__parentId`.
 */
export async function* downloadBulkResults<T extends BulkNode>(
  url: string,
): AsyncGenerator<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download bulk results: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Bulk results response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let lineCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const newlineIdx = buffer.lastIndexOf("\n");
      if (newlineIdx === -1) continue;

      const complete = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      for (const line of complete.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as T;
          lineCount++;
        } catch {
          logger.warn({ line: trimmed.slice(0, 100) }, "Failed to parse JSONL line — skipping");
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer.trim()) as T;
        lineCount++;
      } catch {
        logger.warn({ buffer: buffer.trim().slice(0, 100) }, "Failed to parse final JSONL line");
      }
    }
  } finally {
    reader.releaseLock();
  }

  logger.debug({ lineCount }, "Bulk download complete");
}

/**
 * End-to-end helper: create bulk operation → poll → download.
 * Returns an AsyncGenerator of JSONL nodes.
 */
export async function* runBulkQuery<T extends BulkNode>(
  client: ShopifyClient,
  query: string,
): AsyncGenerator<T> {
  logger.info("Starting bulk operation");
  const operationId = await createBulkOperation(client, query);
  const operation = await pollBulkOperation(client, operationId);

  if (!operation.url) {
    logger.info("Bulk operation returned no URL — empty result set");
    return;
  }

  logger.info(
    { objectCount: operation.objectCount, url: operation.url.slice(0, 80) },
    "Downloading bulk results",
  );
  yield* downloadBulkResults<T>(operation.url);
}

/**
 * Group JSONL bulk nodes into a product-centric structure.
 * Collects all lines into memory — safe up to ~100k nodes.
 */
export interface GroupedBulkData<
  P extends BulkNode,
  C extends BulkNode,
> {
  parent: P;
  children: C[];
}

export async function groupBulkByParent<P extends BulkNode, C extends BulkNode>(
  generator: AsyncGenerator<BulkNode>,
  isParent: (node: BulkNode) => boolean,
  isChild: (node: BulkNode) => boolean,
): Promise<Map<string, GroupedBulkData<P, C>>> {
  const parents = new Map<string, P>();
  const childrenByParent = new Map<string, C[]>();

  for await (const node of generator) {
    if (!node.__parentId && isParent(node)) {
      parents.set(node.id, node as P);
    } else if (node.__parentId && isChild(node)) {
      const list = childrenByParent.get(node.__parentId) ?? [];
      list.push(node as C);
      childrenByParent.set(node.__parentId, list);
    }
  }

  const result = new Map<string, GroupedBulkData<P, C>>();
  for (const [id, parent] of parents) {
    result.set(id, { parent, children: childrenByParent.get(id) ?? [] });
  }
  return result;
}
