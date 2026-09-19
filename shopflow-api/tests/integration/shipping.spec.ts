import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OrderAlreadyCancelledError,
  OrderAlreadyShippedError,
  OrderNotFoundError,
} from '../../src/domain/errors';
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

interface ShipmentRow {
  status: string;
  shipped_at: Date | null;
  updated_at: Date;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
}

async function shipmentRow(pool: Pool, orderId: string): Promise<ShipmentRow> {
  const result = await pool.query(
    'SELECT status, shipped_at, updated_at, cancelled_at, cancellation_reason FROM orders WHERE id = $1',
    [orderId],
  );
  const row = result.rows[0] as ShipmentRow | undefined;
  if (row === undefined) {
    throw new Error(`order ${orderId} not found`);
  }
  return row;
}

describe('administrative SHIPPED action against real PostgreSQL 16', () => {
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

  it('marks a CONFIRMED order SHIPPED with shipped_at and without touching inventory', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 2 }],
    });
    const inventoryAfterOrder = await availableQuantity(pool, ESPRESSO);

    const shipped = await container.useCases.shipOrder.execute(order.id);

    expect(shipped.status).toBe('SHIPPED');
    expect(shipped.shippedAt).not.toBeNull();
    expect(shipped.cancelledAt).toBeNull();
    expect(shipped.cancellationReason).toBeNull();

    const row = await shipmentRow(pool, order.id);
    expect(row.status).toBe('SHIPPED');
    expect(row.shipped_at?.toISOString()).toBe(shipped.shippedAt);
    expect(row.cancelled_at).toBeNull();
    expect(row.cancellation_reason).toBeNull();
    expect(await availableQuantity(pool, ESPRESSO)).toBe(inventoryAfterOrder);
    // Shipping is not a notification trigger.
    expect(await countRows(pool, 'notification_outbox')).toBe(1);
  });

  it('is idempotent: a repeated ship returns the original shippedAt and writes nothing', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    const first = await container.useCases.shipOrder.execute(order.id);
    const rowAfterFirst = await shipmentRow(pool, order.id);

    const second = await container.useCases.shipOrder.execute(order.id);

    expect(second.shippedAt).toBe(first.shippedAt);
    expect(second.updatedAt).toBe(first.updatedAt);
    const rowAfterSecond = await shipmentRow(pool, order.id);
    expect(rowAfterSecond.shipped_at?.getTime()).toBe(rowAfterFirst.shipped_at?.getTime());
    expect(rowAfterSecond.updated_at.getTime()).toBe(rowAfterFirst.updated_at.getTime());
  });

  it('rejects shipping a CANCELLED order and writes nothing', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });
    await container.useCases.cancelOrder.execute(order.id, 'changed my mind');
    const before = await shipmentRow(pool, order.id);

    await expect(container.useCases.shipOrder.execute(order.id)).rejects.toBeInstanceOf(
      OrderAlreadyCancelledError,
    );

    expect(await shipmentRow(pool, order.id)).toEqual(before);
    expect(await countRows(pool, 'notification_outbox')).toBe(2);
  });

  it('rejects cancelling a SHIPPED order without restoring inventory', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 2 }],
    });
    await container.useCases.shipOrder.execute(order.id);
    const inventoryBefore = await availableQuantity(pool, ESPRESSO);

    await expect(
      container.useCases.cancelOrder.execute(order.id, 'too late'),
    ).rejects.toBeInstanceOf(OrderAlreadyShippedError);

    expect(await availableQuantity(pool, ESPRESSO)).toBe(inventoryBefore);
    const row = await shipmentRow(pool, order.id);
    expect(row.status).toBe('SHIPPED');
    expect(row.cancelled_at).toBeNull();
    expect(row.cancellation_reason).toBeNull();
    expect(await countRows(pool, 'notification_outbox')).toBe(1);
  });

  it('rejects an unknown order for both actions', async () => {
    await expect(container.useCases.shipOrder.execute('order-missing')).rejects.toBeInstanceOf(
      OrderNotFoundError,
    );
    await expect(
      container.useCases.cancelOrder.execute('order-missing', 'whatever'),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it('handles concurrent ship and cancel of the same order without corrupting it', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 2 }],
    });

    const errorCodeOf = async (work: Promise<unknown>): Promise<string | null> => {
      try {
        await work;
        return null;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' ? code : 'NON_DOMAIN_ERROR';
      }
    };

    // Both actions race on the same order row: the lock serializes them, so exactly one
    // transition wins and the loser gets the matching 409 domain error.
    const [shipError, cancelError] = await Promise.all([
      errorCodeOf(container.useCases.shipOrder.execute(order.id)),
      errorCodeOf(container.useCases.cancelOrder.execute(order.id, 'customer cancelled')),
    ]);

    const row = await shipmentRow(pool, order.id);

    if (row.status === 'SHIPPED') {
      expect(row.shipped_at).not.toBeNull();
      expect(row.cancelled_at).toBeNull();
      expect(cancelError).toBe('ORDER_ALREADY_SHIPPED');
      expect(await availableQuantity(pool, ESPRESSO)).toBe(3);
      expect(await countRows(pool, 'notification_outbox')).toBe(1);
    } else {
      expect(row.status).toBe('CANCELLED');
      expect(row.cancelled_at).not.toBeNull();
      expect(row.cancellation_reason).toBe('customer cancelled');
      expect(shipError).toBe('ORDER_ALREADY_CANCELLED');
      expect(await availableQuantity(pool, ESPRESSO)).toBe(5);
      expect(await countRows(pool, 'notification_outbox')).toBe(2);
    }
  });
});
