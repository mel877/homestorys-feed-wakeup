import { pool } from "@workspace/db";

const MARKET_PRICE_WRITE_LOCK = "homestorys:market-price-write";

export interface MarketPriceWriteLease {
  release(): Promise<void>;
}

/**
 * Acquire a PostgreSQL session advisory lock on the same database connection
 * used for all price writes. The dedicated client remains checked out until
 * release(), so the lock works across Autoscale instances, not only in-process.
 */
export async function tryAcquireMarketPriceWriteLock(): Promise<MarketPriceWriteLease | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [MARKET_PRICE_WRITE_LOCK],
    );
    if (!result.rows[0]?.acquired) {
      client.release();
      return null;
    }

    let released = false;
    return {
      async release(): Promise<void> {
        if (released) return;
        released = true;
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [MARKET_PRICE_WRITE_LOCK],
          );
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function withMarketPriceWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [MARKET_PRICE_WRITE_LOCK],
    );
    return await fn();
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [MARKET_PRICE_WRITE_LOCK],
      );
    } finally {
      client.release();
    }
  }
}