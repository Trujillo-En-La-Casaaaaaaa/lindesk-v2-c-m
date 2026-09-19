import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidCancellationReasonError,
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
const GRINDER = 'prod-burr-grinder';

interface CancelledOrderRow {
  status: string;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  updated_at: Date;
}

async function cancelledOrderRow(pool: Pool, orderId: string): Promise<CancelledOrderRow> {
  const result = await pool.query(
    'SELECT status, cancelled_at, cancellation_reason, updated_at FROM orders WHERE id = $1',
    [orderId],
  );
  const row = result.rows[0] as CancelledOrderRow | undefined;
  if (row === undefined) {
    throw new Error(`order ${orderId} not found`);
  }
  return row;
}

async function outboxRowsByType(
  pool: Pool,
  orderId: string,
  type: string,
): Promise<Array<{ dedupe_key: string; status: string; payload: Record<string, unknown> }>> {
  const result = await pool.query(
    'SELECT dedupe_key, status, payload FROM notification_outbox WHERE order_id = $1 AND type = $2',
    [orderId, type],
  );
  return result.rows as Array<{ dedupe_key: string; status: string; payload: Record<string, unknown> }>;
}

describe('order cancellation against real PostgreSQL 16', () => {
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

  it('sets status/cancelledAt/cancellationReason, restores inventory exactly once, and records one ORDER_CANCELLED intent', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [
        { productId: ESPRESSO, quantity: 2 },
        { productId: GRINDER, quantity: 1 },
      ],
    });
    expect(await availableQuantity(pool, ESPRESSO)).toBe(3);

    const cancelled = await container.useCases.cancelOrder.execute(order.id, '  Ordered wrong size  ');

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellationReason).toBe('Ordered wrong size');
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.shippedAt).toBeNull();

    const row = await cancelledOrderRow(pool, order.id);
    expect(row.status).toBe('CANCELLED');
    expect(row.cancellation_reason).toBe('Ordered wrong size');
    expect(row.cancelled_at?.toISOString()).toBe(cancelled.cancelledAt);
    expect(row.updated_at.toISOString()).toBe(cancelled.updatedAt);

    // Inventory restored exactly once, back to the seed baseline.
    expect(await availableQuantity(pool, ESPRESSO)).toBe(5);
    expect(await availableQuantity(pool, GRINDER)).toBe(10);

    const intents = await outboxRowsByType(pool, order.id, 'ORDER_CANCELLED');
    expect(intents).toHaveLength(1);
    expect(intents[0].dedupe_key).toBe(`order:${order.id}:cancelled`);
    expect(intents[0].status).toBe('PENDING');
    expect(intents[0].payload).toMatchObject({
      type: 'ORDER_CANCELLED',
      orderId: order.id,
      template: 'order-cancelled',
      data: {
        status: 'CANCELLED',
        totalCents: order.totalCents,
        cancellationReason: 'Ordered wrong size',
      },
    });
    expect(await outboxRowsByType(pool, order.id, 'ORDER_CONFIRMED')).toHaveLength(1);
    expect(await countRows(pool, 'notification_outbox')).toBe(2);
  });

  it('restores inventory exactly once for two concurrent cancellations and records one ORDER_CANCELLED intent', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 3 }],
    });
    expect(await availableQuantity(pool, ESPRESSO)).toBe(2);

    const results = await Promise.all([
      container.useCases.cancelOrder.execute(order.id, 'reason from customer'),
      container.useCases.cancelOrder.execute(order.id, 'reason from support'),
    ]);

    for (const result of results) {
      expect(result.status).toBe('CANCELLED');
    }
    expect(await availableQuantity(pool, ESPRESSO)).toBe(5);

    const intents = await outboxRowsByType(pool, order.id, 'ORDER_CANCELLED');
    expect(intents).toHaveLength(1);
    expect(intents[0].dedupe_key).toBe(`order:${order.id}:cancelled`);

    const row = await cancelledOrderRow(pool, order.id);
    expect(row.status).toBe('CANCELLED');
    expect(['reason from customer', 'reason from support']).toContain(row.cancellation_reason);

    // Both responses must describe the same persisted cancellation.
    expect(results[0].cancelledAt).toBe(results[1].cancelledAt);
    expect(results[0].cancellationReason).toBe(results[1].cancellationReason);
    expect(await countRows(pool, 'notification_outbox')).toBe(2);

    const min = await pool.query('SELECT min(available_quantity)::int AS min FROM inventory');
    expect((min.rows[0] as { min: number }).min).toBeGreaterThanOrEqual(0);
  });

  it('restores inventory exactly once for many concurrent cancellations', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [
        { productId: ESPRESSO, quantity: 1 },
        { productId: GRINDER, quantity: 2 },
      ],
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        container.useCases.cancelOrder.execute(order.id, `reason ${index}`),
      ),
    );

    expect(results).toHaveLength(8);
    for (const result of results) {
      expect(result.status).toBe('CANCELLED');
      expect(result.cancelledAt).toBe(results[0].cancelledAt);
    }
    expect(await availableQuantity(pool, ESPRESSO)).toBe(5);
    expect(await availableQuantity(pool, GRINDER)).toBe(10);
    expect(await outboxRowsByType(pool, order.id, 'ORDER_CANCELLED')).toHaveLength(1);
    expect(await countRows(pool, 'notification_outbox')).toBe(2);
  });

  it('returns the original cancelledAt/cancellationReason on a repeated sequential cancellation with unchanged inventory', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 2 }],
    });

    const first = await container.useCases.cancelOrder.execute(order.id, 'first reason');
    const inventoryAfterFirst = await availableQuantity(pool, ESPRESSO);
    const rowAfterFirst = await cancelledOrderRow(pool, order.id);

    const second = await container.useCases.cancelOrder.execute(order.id, 'second reason');

    expect(second.cancelledAt).toBe(first.cancelledAt);
    expect(second.cancellationReason).toBe('first reason');
    expect(second.updatedAt).toBe(first.updatedAt);

    expect(await availableQuantity(pool, ESPRESSO)).toBe(inventoryAfterFirst);
    const rowAfterSecond = await cancelledOrderRow(pool, order.id);
    expect(rowAfterSecond.cancelled_at?.getTime()).toBe(rowAfterFirst.cancelled_at?.getTime());
    expect(rowAfterSecond.updated_at.getTime()).toBe(rowAfterFirst.updated_at.getTime());
    expect(await outboxRowsByType(pool, order.id, 'ORDER_CANCELLED')).toHaveLength(1);
    expect(await countRows(pool, 'notification_outbox')).toBe(2);
  });

  it('rejects an empty or over-long reason without changing anything', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });
    const before = await cancelledOrderRow(pool, order.id);
    const inventoryBefore = await availableQuantity(pool, ESPRESSO);

    await expect(
      container.useCases.cancelOrder.execute(order.id, '   '),
    ).rejects.toBeInstanceOf(InvalidCancellationReasonError);
    await expect(
      container.useCases.cancelOrder.execute(order.id, 'x'.repeat(201)),
    ).rejects.toMatchObject({ code: 'INVALID_CANCELLATION_REASON' });

    const after = await cancelledOrderRow(pool, order.id);
    expect(after).toEqual(before);
    expect(after.status).toBe('CONFIRMED');
    expect(await availableQuantity(pool, ESPRESSO)).toBe(inventoryBefore);
    expect(await outboxRowsByType(pool, order.id, 'ORDER_CANCELLED')).toHaveLength(0);
    expect(await countRows(pool, 'notification_outbox')).toBe(1);
  });

  it('accepts a reason of exactly 200 characters', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    const reason = 'y'.repeat(200);
    const cancelled = await container.useCases.cancelOrder.execute(order.id, reason);

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellationReason).toBe(reason);
    const row = await cancelledOrderRow(pool, order.id);
    expect(row.cancellation_reason).toBe(reason);
  });

  it('rejects an unknown order', async () => {
    await expect(
      container.useCases.cancelOrder.execute('order-missing', 'whatever'),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(await countRows(pool, 'notification_outbox')).toBe(0);
  });

  it('enforces notification_outbox.dedupe_key uniqueness on the real database', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    await expect(
      pool.query(
        `INSERT INTO notification_outbox (id, dedupe_key, type, order_id, payload)
         VALUES ('manual-outbox', $1, 'ORDER_CONFIRMED', $2, '{}'::jsonb)`,
        [`order:${order.id}:confirmed`, order.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    expect(await countRows(pool, 'notification_outbox')).toBe(1);
  });
});
