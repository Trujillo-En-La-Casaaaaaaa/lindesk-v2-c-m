import type { Pool, PoolClient } from 'pg';
import type { Logger } from '../../../../application/ports/outbound/logger.port';
import type {
  TransactionContext,
  UnitOfWork,
} from '../../../../application/ports/outbound/unit-of-work.port';
import { PgSqlExecutor } from './pg-sql-executor';
import { PostgresInventoryRepository } from './postgres-inventory.repository';
import { PostgresOrderRepository } from './postgres-order.repository';
import { PostgresOutboxRepository } from './postgres-outbox.repository';
import { PostgresProductRepository } from './postgres-product.repository';

/** Repositories bound to one dedicated connection/transaction. */
function buildTransactionContext(client: PoolClient): TransactionContext {
  const executor = new PgSqlExecutor(client);
  return {
    products: new PostgresProductRepository(executor),
    inventory: new PostgresInventoryRepository(executor),
    orders: new PostgresOrderRepository(executor),
    outbox: new PostgresOutboxRepository(executor),
  };
}

export interface PostgresUnitOfWorkOptions {
  readonly logger?: Logger | undefined;
}

/**
 * PostgreSQL unit of work: BEGIN → callback → COMMIT, or ROLLBACK on any error.
 * The callback receives repositories bound to the transaction's own connection, so order
 * status, timestamps, cancellation reason, inventory change, and outbox intent commit or roll
 * back together.
 */
export class PostgresUnitOfWork implements UnitOfWork {
  private closed = false;

  constructor(
    private readonly pool: Pool,
    private readonly options: PostgresUnitOfWorkOptions = {},
  ) {}

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(buildTransactionContext(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // The connection is unusable for this caller either way; report the original error.
        this.options.logger?.warn('rollback failed', {
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Health probe used by GET /health. Never throws. */
  async probe(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      this.options.logger?.debug('database probe failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.pool.end();
  }
}
