import pg from "pg";

pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// BIGINT (int8) as a JS number. Safe here: amounts are cents, far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Queryable = Pick<pg.PoolClient, "query">;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Run `fn` inside a transaction; commit on success, roll back on any error. */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` in a transaction scoped to one tenant.
 * set_config(..., true) is transaction-local, so the setting can never leak
 * to the next request that reuses this pooled connection.
 */
export function withTenant<T>(pool: pg.Pool, orgId: string, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (tx) => {
    await tx.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    return fn(tx);
  });
}
