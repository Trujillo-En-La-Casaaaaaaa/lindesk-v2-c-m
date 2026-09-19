import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Container } from '../../src/composition/container';
import { createTestContainer } from '../helpers/app';
import {
  countRows,
  createTestPool,
  ensureSchema,
  resetDatabase,
} from '../helpers/database';
import {
  startNotificationEmulator,
  type NotificationEmulator,
} from '../helpers/notification-emulator';
import { waitFor } from '../helpers/process';

const ESPRESSO = 'prod-espresso-machine';

interface OutboxStateRow {
  status: string;
  attempts: number;
  last_error: string | null;
  sent_at: Date | null;
  dedupe_key: string;
  type: string;
}

async function outboxState(pool: Pool, orderId: string, type: string): Promise<OutboxStateRow> {
  const result = await pool.query(
    'SELECT status, attempts, last_error, sent_at, dedupe_key, type FROM notification_outbox WHERE order_id = $1 AND type = $2',
    [orderId, type],
  );
  const row = result.rows[0] as OutboxStateRow | undefined;
  if (row === undefined) {
    throw new Error(`no ${type} outbox row for order ${orderId}`);
  }
  return row;
}

describe('outbox dispatcher + HTTP notification adapter (real PostgreSQL, real HTTP)', () => {
  let pool: Pool;
  let container: Container;
  let emulator: NotificationEmulator;

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    emulator = await startNotificationEmulator();
    container = createTestContainer({
      notificationProviderUrl: emulator.baseUrl,
      outboxMaxAttempts: 2,
      outboxPollIntervalMs: 25,
    });
    await resetDatabase(pool);
  });

  afterEach(async () => {
    await container.close();
    await emulator.close();
  });

  it('delivers an ORDER_CONFIRMED intent with Idempotency-Key and marks the row SENT', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    const result = await container.dispatcher.runBatch();

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(emulator.received).toHaveLength(1);
    const request = emulator.received[0];
    expect(request.idempotencyKey).toBe(`order:${order.id}:confirmed`);
    expect(request.contentType).toContain('application/json');
    expect(request.body).toEqual({
      type: 'ORDER_CONFIRMED',
      orderId: order.id,
      customerId: 'customer-demo',
      recipient: 'customer:customer-demo',
      template: 'order-confirmed',
      occurredAt: order.createdAt,
      dedupeKey: `order:${order.id}:confirmed`,
      data: { status: 'CONFIRMED', totalCents: order.totalCents, currency: 'USD' },
    });
    expect(emulator.logicalCount()).toBe(1);
    expect(emulator.requestsToUnknownPath).toEqual([]);

    const state = await outboxState(pool, order.id, 'ORDER_CONFIRMED');
    expect(state.status).toBe('SENT');
    expect(state.sent_at).not.toBeNull();
    expect(state.last_error).toBeNull();
  });

  it('delivers an ORDER_CANCELLED intent with the cancellation reason in data', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });
    await container.useCases.cancelOrder.execute(order.id, 'wrong size');

    const result = await container.dispatcher.runBatch();

    expect(result.sent).toBe(2);
    const cancellation = emulator.received.find(
      (request) => request.body['type'] === 'ORDER_CANCELLED',
    );
    expect(cancellation).toBeDefined();
    expect(cancellation?.idempotencyKey).toBe(`order:${order.id}:cancelled`);
    expect(cancellation?.body).toMatchObject({
      type: 'ORDER_CANCELLED',
      orderId: order.id,
      template: 'order-cancelled',
      dedupeKey: `order:${order.id}:cancelled`,
      data: { status: 'CANCELLED', cancellationReason: 'wrong size' },
    });
    expect(emulator.logicalCount()).toBe(2);
    expect((await outboxState(pool, order.id, 'ORDER_CANCELLED')).status).toBe('SENT');
  });

  it('retries a failing delivery and marks the row FAILED after the attempt budget', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });
    emulator.setMode('server-error');

    const first = await container.dispatcher.runBatch();
    expect(first).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
    const afterFirst = await outboxState(pool, order.id, 'ORDER_CONFIRMED');
    expect(afterFirst.status).toBe('PENDING');
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.last_error).toContain('500');

    const second = await container.dispatcher.runBatch();
    expect(second).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
    const afterSecond = await outboxState(pool, order.id, 'ORDER_CONFIRMED');
    expect(afterSecond.status).toBe('FAILED');
    expect(afterSecond.attempts).toBe(2);
    expect(afterSecond.sent_at).toBeNull();

    // FAILED rows are no longer claimed.
    const third = await container.dispatcher.runBatch();
    expect(third).toEqual({ claimed: 0, sent: 0, retried: 0, failed: 0 });
    expect(emulator.received).toHaveLength(2);
  });

  it('collapses an at-least-once redelivery into one logical notification', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    await container.dispatcher.runBatch();
    expect((await outboxState(pool, order.id, 'ORDER_CONFIRMED')).status).toBe('SENT');

    // Simulate a crash after the provider accepted the request but before the row was marked:
    // the intent is replayed with the same idempotency key.
    await pool.query(
      `UPDATE notification_outbox SET status = 'PENDING', sent_at = NULL WHERE order_id = $1`,
      [order.id],
    );
    const replay = await container.dispatcher.runBatch();

    expect(replay.sent).toBe(1);
    expect(emulator.received).toHaveLength(2);
    expect(emulator.received[0].idempotencyKey).toBe(emulator.received[1].idempotencyKey);
    expect(emulator.logicalCount()).toBe(1);
    expect((await outboxState(pool, order.id, 'ORDER_CONFIRMED')).status).toBe('SENT');
  });

  it('dispatches pending intents through the running polling loop', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    container.dispatcher.start();
    await waitFor(
      async () => (await outboxState(pool, order.id, 'ORDER_CONFIRMED')).status === 'SENT',
      5_000,
    );
    await container.dispatcher.stop();

    expect(emulator.received).toHaveLength(1);
    expect(emulator.received[0].idempotencyKey).toBe(`order:${order.id}:confirmed`);
    expect(await countRows(pool, 'notification_outbox')).toBe(1);
  });

  it('leaves inventory and orders untouched when only notifications fail', async () => {
    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 2 }],
    });
    emulator.setMode('server-error');

    await container.dispatcher.runBatch();

    const inventory = await pool.query(
      'SELECT available_quantity FROM inventory WHERE product_id = $1',
      [ESPRESSO],
    );
    expect((inventory.rows[0] as { available_quantity: number }).available_quantity).toBe(3);
    const state = await outboxState(pool, order.id, 'ORDER_CONFIRMED');
    expect(state.status).toBe('PENDING');
    expect(state.attempts).toBe(1);
    expect(await countRows(pool, 'notification_outbox')).toBe(1);
  });
});
