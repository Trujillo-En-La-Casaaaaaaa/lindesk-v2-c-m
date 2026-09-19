import type { Logger } from '../../src/application/ports/outbound/logger.port';
import type { Clock } from '../../src/application/ports/outbound/clock.port';
import type { IdGenerator } from '../../src/application/ports/outbound/id-generator.port';
import type {
  InventoryRepository,
} from '../../src/application/ports/outbound/inventory-repository.port';
import type { NewOutboxEntry, OutboxEntry, OutboxFailureResult, OutboxRepository, OutboxStatus } from '../../src/application/ports/outbound/outbox-repository.port';
import type { OrderRepository } from '../../src/application/ports/outbound/order-repository.port';
import type { ProductRepository } from '../../src/application/ports/outbound/product-repository.port';
import type { TransactionContext, UnitOfWork } from '../../src/application/ports/outbound/unit-of-work.port';
import type { Inventory, Product, ProductWithAvailability } from '../../src/domain/model/product';
import type { Order, OrderItem } from '../../src/domain/model/order';

/** In-memory state used by the unit tests. Rolled back by the fake unit of work. */
export interface FakeState {
  products: Product[];
  inventory: Inventory[];
  orders: Order[];
  orderItems: OrderItem[];
  outbox: OutboxEntry[];
}

/** Observability for the fakes: proves how many mutations a use case performed. */
export interface FakeCallLog {
  readonly locks: string[][];
  readonly decrements: Array<{ productId: string; quantity: number }>;
  readonly increments: Array<{ productId: string; quantity: number }>;
  readonly notifications: string[];
}

export function createCallLog(): FakeCallLog {
  return { locks: [], decrements: [], increments: [], notifications: [] };
}

export function makeProduct(overrides: Partial<Product> & Pick<Product, 'id'>): Product {
  return {
    sku: overrides.id.toUpperCase(),
    name: overrides.id,
    description: '',
    priceCents: 1000,
    currency: 'USD',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export interface StoreSeed {
  readonly products: readonly Product[];
  readonly quantities: Readonly<Record<string, number>>;
}

export class InMemoryStore {
  state: FakeState;

  constructor(seed: StoreSeed) {
    this.state = {
      products: [...seed.products],
      inventory: seed.products.map((product) => ({
        productId: product.id,
        availableQuantity: seed.quantities[product.id] ?? 0,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      })),
      orders: [],
      orderItems: [],
      outbox: [],
    };
  }

  snapshot(): FakeState {
    return structuredClone(this.state);
  }

  restore(snapshot: FakeState): void {
    this.state = snapshot;
  }

  availableQuantity(productId: string): number {
    const row = this.state.inventory.find((entry) => entry.productId === productId);
    if (row === undefined) {
      throw new Error(`fake: no inventory row for ${productId}`);
    }
    return row.availableQuantity;
  }
}

export class InMemoryProductRepository implements ProductRepository {
  constructor(private readonly store: InMemoryStore) {}

  findById(id: string): Promise<Product | null> {
    return Promise.resolve(this.store.state.products.find((product) => product.id === id) ?? null);
  }

  findByIds(ids: readonly string[]): Promise<readonly Product[]> {
    return Promise.resolve(
      this.store.state.products
        .filter((product) => ids.includes(product.id))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  listWithAvailability(): Promise<readonly ProductWithAvailability[]> {
    const rows = this.store.state.products
      .map((product) => ({
        product,
        availableQuantity: this.store.availableQuantity(product.id),
      }))
      .sort(
        (left, right) =>
          left.product.name.localeCompare(right.product.name) ||
          left.product.id.localeCompare(right.product.id),
      );
    return Promise.resolve(rows);
  }

  findWithAvailability(id: string): Promise<ProductWithAvailability | null> {
    const product = this.store.state.products.find((candidate) => candidate.id === id);
    if (product === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ product, availableQuantity: this.store.availableQuantity(id) });
  }
}

export class InMemoryInventoryRepository implements InventoryRepository {
  constructor(
    private readonly store: InMemoryStore,
    private readonly calls: FakeCallLog,
  ) {}

  lockByProductIds(productIds: readonly string[]): Promise<readonly Inventory[]> {
    this.calls.locks.push([...productIds]);
    // Mirrors the SQL ORDER BY product_id ASC (FOR UPDATE) row ordering.
    const rows = this.store.state.inventory
      .filter((row) => productIds.includes(row.productId))
      .sort((left, right) => left.productId.localeCompare(right.productId));
    return Promise.resolve(structuredClone(rows));
  }

  decrement(productId: string, quantity: number): Promise<void> {
    this.calls.decrements.push({ productId, quantity });
    const index = this.store.state.inventory.findIndex((entry) => entry.productId === productId);
    const row = this.store.state.inventory[index];
    if (row === undefined) {
      throw new Error(`fake: cannot decrement missing inventory row ${productId}`);
    }
    const availableQuantity = row.availableQuantity - quantity;
    if (availableQuantity < 0) {
      throw new Error(`fake: inventory for ${productId} went negative`);
    }
    this.store.state.inventory[index] = { ...row, availableQuantity };
    return Promise.resolve();
  }

  increment(productId: string, quantity: number): Promise<void> {
    this.calls.increments.push({ productId, quantity });
    const index = this.store.state.inventory.findIndex((entry) => entry.productId === productId);
    const row = this.store.state.inventory[index];
    if (row === undefined) {
      this.store.state.inventory.push({
        productId,
        availableQuantity: quantity,
        updatedAt: new Date(),
      });
      return Promise.resolve();
    }
    this.store.state.inventory[index] = {
      ...row,
      availableQuantity: row.availableQuantity + quantity,
    };
    return Promise.resolve();
  }
}

export class InMemoryOrderRepository implements OrderRepository {
  constructor(private readonly store: InMemoryStore) {}

  insert(order: Order): Promise<void> {
    this.store.state.orders.push(structuredClone(order));
    return Promise.resolve();
  }

  insertItems(items: readonly OrderItem[]): Promise<void> {
    this.store.state.orderItems.push(...items.map((item) => structuredClone(item)));
    return Promise.resolve();
  }

  findById(id: string): Promise<Order | null> {
    return Promise.resolve(this.store.state.orders.find((order) => order.id === id) ?? null);
  }

  findByIdForUpdate(id: string): Promise<Order | null> {
    return this.findById(id);
  }

  listItems(orderId: string): Promise<readonly OrderItem[]> {
    const items = this.store.state.orderItems
      .filter((item) => item.orderId === orderId)
      .sort((left, right) => left.productId.localeCompare(right.productId));
    return Promise.resolve(structuredClone(items));
  }

  listItemsByOrderIds(orderIds: readonly string[]): Promise<readonly OrderItem[]> {
    const items = this.store.state.orderItems
      .filter((item) => orderIds.includes(item.orderId))
      .sort(
        (left, right) =>
          left.orderId.localeCompare(right.orderId) || left.productId.localeCompare(right.productId),
      );
    return Promise.resolve(structuredClone(items));
  }

  listRecent(limit: number): Promise<readonly Order[]> {
    const orders = [...this.store.state.orders]
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
      )
      .slice(0, limit);
    return Promise.resolve(structuredClone(orders));
  }

  markCancelled(input: {
    orderId: string;
    cancelledAt: Date;
    reason: string;
    updatedAt: Date;
  }): Promise<void> {
    const index = this.store.state.orders.findIndex((order) => order.id === input.orderId);
    if (index === -1) {
      throw new Error(`fake: cannot cancel missing order ${input.orderId}`);
    }
    const current = this.store.state.orders[index];
    this.store.state.orders[index] = {
      ...current,
      status: 'CANCELLED',
      cancelledAt: input.cancelledAt,
      cancellationReason: input.reason,
      updatedAt: input.updatedAt,
      shippedAt: null,
    };
    return Promise.resolve();
  }

  markShipped(input: { orderId: string; shippedAt: Date; updatedAt: Date }): Promise<void> {
    const index = this.store.state.orders.findIndex((order) => order.id === input.orderId);
    if (index === -1) {
      throw new Error(`fake: cannot ship missing order ${input.orderId}`);
    }
    const current = this.store.state.orders[index];
    this.store.state.orders[index] = {
      ...current,
      status: 'SHIPPED',
      shippedAt: input.shippedAt,
      updatedAt: input.updatedAt,
    };
    return Promise.resolve();
  }
}

export class InMemoryOutboxRepository implements OutboxRepository {
  constructor(private readonly store: InMemoryStore) {}

  enqueue(entry: NewOutboxEntry): Promise<void> {
    const duplicate = this.store.state.outbox.some((row) => row.dedupeKey === entry.dedupeKey);
    if (duplicate) {
      // Mirrors the UNIQUE constraint on notification_outbox.dedupe_key.
      throw new Error(`duplicate key value violates unique constraint: ${entry.dedupeKey}`);
    }
    this.store.state.outbox.push({
      ...structuredClone(entry),
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      sentAt: null,
    });
    return Promise.resolve();
  }

  findPending(limit: number): Promise<readonly OutboxEntry[]> {
    const rows = this.store.state.outbox
      .filter((row) => row.status === 'PENDING')
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(0, limit);
    return Promise.resolve(structuredClone(rows));
  }

  markSent(id: string, sentAt: Date): Promise<void> {
    const index = this.store.state.outbox.findIndex((entry) => entry.id === id);
    const row = this.store.state.outbox[index];
    if (row === undefined) {
      throw new Error(`fake: cannot mark missing outbox row ${id} as sent`);
    }
    this.store.state.outbox[index] = { ...row, status: 'SENT', sentAt, lastError: null };
    return Promise.resolve();
  }

  recordFailure(id: string, lastError: string, maxAttempts: number): Promise<OutboxFailureResult> {
    const index = this.store.state.outbox.findIndex((entry) => entry.id === id);
    const row = this.store.state.outbox[index];
    if (row === undefined) {
      throw new Error(`fake: cannot record failure for missing outbox row ${id}`);
    }
    const attempts = row.attempts + 1;
    const status: OutboxStatus = attempts >= maxAttempts ? 'FAILED' : 'PENDING';
    this.store.state.outbox[index] = { ...row, attempts, lastError, status };
    return Promise.resolve({ status, attempts });
  }
}

/**
 * Fake unit of work with snapshot/rollback semantics, so "nothing is written" assertions in
 * the unit tests are meaningful.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  private readonly context: TransactionContext;
  private commitCount = 0;
  private rollbackCount = 0;

  constructor(
    private readonly store: InMemoryStore,
    calls: FakeCallLog = createCallLog(),
  ) {
    this.context = {
      products: new InMemoryProductRepository(store),
      inventory: new InMemoryInventoryRepository(store, calls),
      orders: new InMemoryOrderRepository(store),
      outbox: new InMemoryOutboxRepository(store),
    };
  }

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const snapshot = this.store.snapshot();
    try {
      const result = await work(this.context);
      this.commitCount += 1;
      return result;
    } catch (error) {
      this.rollbackCount += 1;
      this.store.restore(snapshot);
      throw error;
    }
  }

  probe(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  get commits(): number {
    return this.commitCount;
  }

  get rollbacks(): number {
    return this.rollbackCount;
  }
}

export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    const value = this.current;
    this.current = new Date(value.getTime() + 1_000);
    return value;
  }

  set(date: Date): void {
    this.current = date;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = 'id') {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}-${String(this.counter).padStart(3, '0')}`;
  }
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
