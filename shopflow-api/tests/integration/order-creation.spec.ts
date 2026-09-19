import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InsufficientInventoryError, ProductNotFoundError, ValidationError } from '../../src/domain/errors';
import type { Container } from '../../src/composition/container';
import { createTestContainer } from '../helpers/app';
import {
  availableQuantity,
  countRows,
  createTestPool,
  ensureSchema,
  resetDatabase,
} from '../helpers/database';

const ESPRESSO = 'prod-espresso-machine';
const GRINDER = 'prod-burr-grinder';
const PITCHER = 'prod-milk-pitcher';

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
  order_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
}

async function orderRow(pool: Pool, id: string): Promise<OrderRow> {
  const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  const row = result.rows[0] as OrderRow | undefined;
  if (row === undefined) {
    throw new Error(`order ${id} not found`);
  }
  return row;
}

async function itemRows(pool: Pool, orderId: string): Promise<OrderItemRow[]> {
  const result = await pool.query(
    'SELECT order_id, product_id, product_name, quantity, unit_price_cents, line_total_cents FROM order_items WHERE order_id = $1 ORDER BY product_id',
    [orderId],
  );
  return result.rows as OrderItemRow[];
}

describe('order creation against real PostgreSQL 16', () => {
  let pool: Pool;
  let container: Container;

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
    container = createTestContainer();
  });

  afterAll(async () => {
    await container.close();
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it('creates a CONFIRMED order, decrements inventory, and records one ORDER_CONFIRMED intent', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [
        { productId: ESPRESSO, quantity: 2 },
        { productId: GRINDER, quantity: 1 },
      ],
    });

    expect(order.status).toBe('CONFIRMED');
    expect(order.totalCents).toBe(24999 * 2 + 8999);
    expect(order.currency).toBe('USD');

    // Inventory decremented by exactly the requested quantities.
    expect(await availableQuantity(pool, ESPRESSO)).toBe(3);
    expect(await availableQuantity(pool, GRINDER)).toBe(9);
    expect(await availableQuantity(pool, PITCHER)).toBe(25);

    const row = await orderRow(pool, order.id);
    expect(row.status).toBe('CONFIRMED');
    expect(row.total_cents).toBe(24999 * 2 + 8999);
    expect(row.customer_id).toBe('customer-demo');
    expect(row.shipped_at).toBeNull();
    expect(row.cancelled_at).toBeNull();
    expect(row.created_at.toISOString()).toBe(order.createdAt);
    expect(row.updated_at.getTime()).toBe(row.created_at.getTime());

    expect(await itemRows(pool, order.id)).toEqual([
      {
        order_id: order.id,
        product_id: GRINDER,
        product_name: 'Burr Coffee Grinder',
        quantity: 1,
        unit_price_cents: 8999,
        line_total_cents: 8999,
      },
      {
        order_id: order.id,
        product_id: ESPRESSO,
        product_name: 'Espresso Machine',
        quantity: 2,
        unit_price_cents: 24999,
        line_total_cents: 49998,
      },
    ]);

    const outbox = await pool.query(
      'SELECT dedupe_key, type, status, attempts, payload FROM notification_outbox WHERE order_id = $1',
      [order.id],
    );
    expect(outbox.rowCount).toBe(1);
    const intent = outbox.rows[0] as {
      dedupe_key: string;
      type: string;
      status: string;
      attempts: number;
      payload: Record<string, unknown>;
    };
    expect(intent.dedupe_key).toBe(`order:${order.id}:confirmed`);
    expect(intent.type).toBe('ORDER_CONFIRMED');
    expect(intent.status).toBe('PENDING');
    expect(intent.attempts).toBe(0);
    expect(intent.payload).toMatchObject({
      type: 'ORDER_CONFIRMED',
      orderId: order.id,
      customerId: 'customer-demo',
      recipient: 'customer:customer-demo',
      template: 'order-confirmed',
      dedupeKey: `order:${order.id}:confirmed`,
      data: { status: 'CONFIRMED', totalCents: order.totalCents, currency: 'USD' },
    });
  });

  it('writes nothing when the requested quantity exceeds availability', async () => {
    await expect(
      container.useCases.createOrder.execute({
        customerId: 'customer-demo',
        items: [{ productId: ESPRESSO, quantity: 6 }],
      }),
    ).rejects.toBeInstanceOf(InsufficientInventoryError);

    expect(await availableQuantity(pool, ESPRESSO)).toBe(5);
    expect(await countRows(pool, 'orders')).toBe(0);
    expect(await countRows(pool, 'order_items')).toBe(0);
    expect(await countRows(pool, 'notification_outbox')).toBe(0);
  });

  it('rolls back a multi-line order when one line is unavailable', async () => {
    await expect(
      container.useCases.createOrder.execute({
        customerId: 'customer-demo',
        items: [
          { productId: PITCHER, quantity: 1 },
          { productId: ESPRESSO, quantity: 5 },
          { productId: GRINDER, quantity: 11 },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_INVENTORY',
      details: { productId: GRINDER, requested: 11, available: 10 },
    });

    expect(await availableQuantity(pool, PITCHER)).toBe(25);
    expect(await availableQuantity(pool, ESPRESSO)).toBe(5);
    expect(await availableQuantity(pool, GRINDER)).toBe(10);
    expect(await countRows(pool, 'orders')).toBe(0);
    expect(await countRows(pool, 'notification_outbox')).toBe(0);
  });

  it('writes nothing for an unknown product', async () => {
    await expect(
      container.useCases.createOrder.execute({
        customerId: 'customer-demo',
        items: [{ productId: 'prod-unknown', quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(ProductNotFoundError);

    expect(await countRows(pool, 'orders')).toBe(0);
    expect(await countRows(pool, 'order_items')).toBe(0);
    expect(await countRows(pool, 'notification_outbox')).toBe(0);
    expect(await availableQuantity(pool, ESPRESSO)).toBe(5);
  });

  it('writes nothing for an invalid request', async () => {
    await expect(
      container.useCases.createOrder.execute({
        customerId: '   ',
        items: [{ productId: ESPRESSO, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      container.useCases.createOrder.execute({
        customerId: 'customer-demo',
        items: [
          { productId: ESPRESSO, quantity: 1 },
          { productId: ESPRESSO, quantity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(await countRows(pool, 'orders')).toBe(0);
    expect(await availableQuantity(pool, ESPRESSO)).toBe(5);
  });

  it('serializes concurrent orders for the same product: exactly one wins, inventory never goes negative', async () => {
    const attempts = Array.from({ length: 6 }, () =>
      container.useCases.createOrder
        .execute({ customerId: 'customer-demo', items: [{ productId: ESPRESSO, quantity: 5 }] })
        .then(
          (order) => ({ status: 'fulfilled' as const, order }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        ),
    );

    const results = await Promise.all(attempts);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const result of rejected) {
      expect(result.error).toMatchObject({ code: 'INSUFFICIENT_INVENTORY' });
    }

    expect(await availableQuantity(pool, ESPRESSO)).toBe(0);
    expect(await countRows(pool, 'orders')).toBe(1);
    expect(await countRows(pool, 'order_items')).toBe(1);
    expect(await countRows(pool, 'notification_outbox')).toBe(1);

    const min = await pool.query('SELECT min(available_quantity)::int AS min FROM inventory');
    expect((min.rows[0] as { min: number }).min).toBeGreaterThanOrEqual(0);
  });

  it('avoids deadlocks when concurrent orders reference the same products in opposite order', async () => {
    const attempts = Array.from({ length: 10 }, (_unused, index) =>
      container.useCases.createOrder
        .execute({
          customerId: `customer-${index}`,
          items:
            index % 2 === 0
              ? [
                  { productId: ESPRESSO, quantity: 1 },
                  { productId: PITCHER, quantity: 1 },
                ]
              : [
                  { productId: PITCHER, quantity: 1 },
                  { productId: ESPRESSO, quantity: 1 },
                ],
        })
        .then(
          (order) => ({ status: 'fulfilled' as const, order }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        ),
    );

    const results = await Promise.all(attempts);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    // 5 units of espresso: exactly five orders can be fulfilled, the rest must be clean 409s.
    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    for (const result of rejected) {
      expect(result.error).toMatchObject({ code: 'INSUFFICIENT_INVENTORY' });
    }
    expect(await availableQuantity(pool, ESPRESSO)).toBe(0);
    expect(await availableQuantity(pool, PITCHER)).toBe(20);
    expect(await countRows(pool, 'orders')).toBe(5);
  });

  it('lists orders newest first and exposes the detail view with items', async () => {
    const first = await container.useCases.createOrder.execute({
      customerId: 'customer-1',
      items: [{ productId: PITCHER, quantity: 1 }],
    });
    const second = await container.useCases.createOrder.execute({
      customerId: 'customer-2',
      items: [{ productId: GRINDER, quantity: 2 }],
    });

    const orders = await container.useCases.listOrders.execute();
    expect(orders.map((order) => order.id)).toEqual([second.id, first.id]);

    const detail = await container.useCases.getOrder.execute(first.id);
    expect(detail.customerId).toBe('customer-1');
    expect(detail.items).toEqual([
      {
        productId: PITCHER,
        productName: 'Milk Pitcher',
        quantity: 1,
        unitPriceCents: 1999,
        lineTotalCents: 1999,
      },
    ]);

    const limited = await container.useCases.listOrders.execute(1);
    expect(limited.map((order) => order.id)).toEqual([second.id]);

    await expect(container.useCases.listOrders.execute(201)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('reflects inventory changes in the product catalog', async () => {
    await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 3 }],
    });

    const products = await container.useCases.listProducts.execute();
    const espresso = products.find((product) => product.id === ESPRESSO);
    expect(espresso?.availableQuantity).toBe(2);
    expect(products.map((product) => product.name)).toEqual([
      'Burr Coffee Grinder',
      'Espresso Machine',
      'Milk Pitcher',
      'Single Origin Coffee Beans 1 kg',
    ]);
  });
});
