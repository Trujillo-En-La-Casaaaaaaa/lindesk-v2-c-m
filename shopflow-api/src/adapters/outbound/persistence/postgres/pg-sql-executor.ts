import type { Pool, PoolClient } from 'pg';
import type { SqlExecutor, SqlQueryResult } from '../../../../application/ports/outbound/sql-executor.port';

/**
 * Adapts a pg `Pool` or `PoolClient` to the driver-free {@link SqlExecutor} surface used by
 * the other persistence adapters.
 */
export class PgSqlExecutor implements SqlExecutor {
  constructor(private readonly client: Pool | PoolClient) {}

  async query<Row>(sql: string, params: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    const result = await this.client.query(sql, params as unknown[]);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  }
}
