import type { Order, OrderItem } from '../../../domain/model/order';

/** Persistence of orders and their items. Always executed inside a unit of work. */
export interface OrderRepository {
  insert(order: Order): Promise<void>;
  insertItems(items: readonly OrderItem[]): Promise<void>;
  findById(id: string): Promise<Order | null>;
  /**
   * `SELECT ... FROM orders WHERE id = $1 FOR UPDATE`: the row lock that makes the
   * cancellation and shipping state machines safe under concurrency.
   */
  findByIdForUpdate(id: string): Promise<Order | null>;
  listItems(orderId: string): Promise<readonly OrderItem[]>;
  listItemsByOrderIds(orderIds: readonly string[]): Promise<readonly OrderItem[]>;
  /** Newest first: `created_at DESC, id DESC`. */
  listRecent(limit: number): Promise<readonly Order[]>;
  markCancelled(input: {
    orderId: string;
    cancelledAt: Date;
    reason: string;
    updatedAt: Date;
  }): Promise<void>;
  markShipped(input: { orderId: string; shippedAt: Date; updatedAt: Date }): Promise<void>;
}
