import { isOrderStatus, type Order, type OrderItem, type OrderStatus } from '../../../../domain/model/order';
import type { OrderRepository } from '../../../../application/ports/outbound/order-repository.port';
import type { SqlExecutor } from '../../../../application/ports/outbound/sql-executor.port';

interface OrderRow {
  id: string;
  customer_id: string;
  status: string;
  total_cents: number;
  currency: string;
  created_at: Date;
  updated_at: Date;
  shipped_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
}

interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
}

const ORDER_COLUMNS = `id, customer_id, status, total_cents, currency, created_at, updated_at,
                       shipped_at, cancelled_at, cancellation_reason`;

/** Order items are always read in ascending `product_id` order so responses are deterministic. */
const ITEM_COLUMNS = `id, order_id, product_id, product_name, quantity, unit_price_cents,
                      line_total_cents`;

function toOrderStatus(value: string): OrderStatus {
  if (!isOrderStatus(value)) {
    throw new Error(`orders.status contains an unsupported value: ${value}`);
  }
  return value;
}

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: toOrderStatus(row.status),
    totalCents: row.total_cents,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shippedAt: row.shipped_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
  };
}

function toOrderItem(row: OrderItemRow): OrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    productId: row.product_id,
    productName: row.product_name,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
  };
}

export class PostgresOrderRepository implements OrderRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async insert(order: Order): Promise<void> {
    await this.executor.query(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency, created_at, updated_at,
                           shipped_at, cancelled_at, cancellation_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        order.id,
        order.customerId,
        order.status,
        order.totalCents,
        order.currency,
        order.createdAt,
        order.updatedAt,
        order.shippedAt,
        order.cancelledAt,
        order.cancellationReason,
      ],
    );
  }

  async insertItems(items: readonly OrderItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const values: unknown[] = [];
    const tuples = items.map((item, index) => {
      const base = index * 7;
      values.push(
        item.id,
        item.orderId,
        item.productId,
        item.productName,
        item.quantity,
        item.unitPriceCents,
        item.lineTotalCents,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await this.executor.query(
      `INSERT INTO order_items (id, order_id, product_id, product_name, quantity,
                                unit_price_cents, line_total_cents)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }

  async findById(id: string): Promise<Order | null> {
    const result = await this.executor.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrder(row);
  }

  async findByIdForUpdate(id: string): Promise<Order | null> {
    const result = await this.executor.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrder(row);
  }

  async listItems(orderId: string): Promise<readonly OrderItem[]> {
    const result = await this.executor.query<OrderItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM order_items WHERE order_id = $1 ORDER BY product_id ASC`,
      [orderId],
    );
    return result.rows.map(toOrderItem);
  }

  async listItemsByOrderIds(orderIds: readonly string[]): Promise<readonly OrderItem[]> {
    if (orderIds.length === 0) {
      return [];
    }
    const result = await this.executor.query<OrderItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM order_items
        WHERE order_id = ANY($1::text[])
        ORDER BY order_id ASC, product_id ASC`,
      [orderIds],
    );
    return result.rows.map(toOrderItem);
  }

  async listRecent(limit: number): Promise<readonly Order[]> {
    const result = await this.executor.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(toOrder);
  }

  async markCancelled(input: {
    orderId: string;
    cancelledAt: Date;
    reason: string;
    updatedAt: Date;
  }): Promise<void> {
    await this.executor.query(
      `UPDATE orders
          SET status = 'CANCELLED',
              cancelled_at = $2,
              cancellation_reason = $3,
              updated_at = $4,
              shipped_at = NULL
        WHERE id = $1`,
      [input.orderId, input.cancelledAt, input.reason, input.updatedAt],
    );
  }

  async markShipped(input: { orderId: string; shippedAt: Date; updatedAt: Date }): Promise<void> {
    await this.executor.query(
      `UPDATE orders
          SET status = 'SHIPPED',
              shipped_at = $2,
              updated_at = $3
        WHERE id = $1`,
      [input.orderId, input.shippedAt, input.updatedAt],
    );
  }
}
