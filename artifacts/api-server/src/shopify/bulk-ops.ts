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
