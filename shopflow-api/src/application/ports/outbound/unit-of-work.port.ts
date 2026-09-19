import type { InventoryRepository } from './inventory-repository.port';
import type { OrderRepository } from './order-repository.port';
import type { OutboxRepository } from './outbox-repository.port';
import type { ProductRepository } from './product-repository.port';

/** Readiness probe for the PostgreSQL database backing the service. */
export interface DatabaseProbe {
  probe(): Promise<boolean>;
}

/** Ports available to a use case for the duration of one transaction. */
export interface TransactionContext {
  readonly products: ProductRepository;
  readonly inventory: InventoryRepository;
  readonly orders: OrderRepository;
  readonly outbox: OutboxRepository;
}

/**
 * Transaction boundary. `run` opens a transaction, hands the callback a context whose
 * repositories are bound to that transaction, commits on success, and rolls back on any error.
 */
export interface UnitOfWork extends DatabaseProbe {
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
