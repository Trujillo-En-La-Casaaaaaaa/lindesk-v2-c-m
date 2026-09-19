import { describe, expect, it } from 'vitest';
import { DispatchNotifications } from '../../../src/application/use-cases/dispatch-notifications.use-case';
import { InMemoryOutboxRepository, silentLogger } from '../../helpers/fakes';
import { ESPRESSO, createUnitFixture } from '../../helpers/unit-fixture';
import { RecordingNotificationPort } from '../../helpers/recording-notification-port';
import type { OutboxEntry } from '../../../src/application/ports/outbound/outbox-repository.port';

type Fixture = ReturnType<typeof createUnitFixture>;

function createDispatcher(options: {
  maxAttempts?: number;
  pollIntervalMs?: number;
  port: RecordingNotificationPort;
}): { fixture: Fixture; dispatcher: DispatchNotifications } {
  const fixture = createUnitFixture();
  const dispatcher = new DispatchNotifications({
    outbox: new InMemoryOutboxRepository(fixture.store),
    notifications: options.port,
    clock: fixture.clock,
    logger: silentLogger,
    pollIntervalMs: options.pollIntervalMs ?? 10,
    maxAttempts: options.maxAttempts ?? 3,
  });
  return { fixture, dispatcher };
}

/**
 * The fake outbox repository replaces rows instead of mutating them, so the row is re-read
 * after every batch instead of holding on to a stale reference.
 */
function outboxRow(fixture: Fixture, index = 0): OutboxEntry {
  const row = fixture.store.state.outbox[index];
  if (row === undefined) {
    throw new Error(`no outbox row at index ${index}`);
  }
  return row;
}

async function seedConfirmedIntent(fixture: Fixture): Promise<void> {
  await fixture.useCases.createOrder.execute({
    customerId: 'customer-demo',
    items: [{ productId: ESPRESSO, quantity: 1 }],
  });
  expect(outboxRow(fixture).type).toBe('ORDER_CONFIRMED');
}

function makePendingRow(index: number): OutboxEntry {
  const dedupeKey = `order:order-${index}:confirmed`;
  return {
    id: `outbox-${index}`,
    dedupeKey,
    type: 'ORDER_CONFIRMED',
    orderId: `order-${index}`,
    payload: {
      type: 'ORDER_CONFIRMED',
      orderId: `order-${index}`,
      customerId: 'customer-demo',
      recipient: 'customer:customer-demo',
      template: 'order-confirmed',
      occurredAt: new Date('2026-09-19T10:15:30.000Z'),
      dedupeKey,
      data: { status: 'CONFIRMED' },
    },
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    createdAt: new Date('2026-09-19T10:15:30.000Z'),
    sentAt: null,
  };
}

describe('DispatchNotifications use case (in-memory fakes)', () => {
  it('marks a delivered row SENT with sent_at and clears last_error', async () => {
    const port = new RecordingNotificationPort();
    const { fixture, dispatcher } = createDispatcher({ port });
    await seedConfirmedIntent(fixture);

    const result = await dispatcher.runBatch();

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(port.messages).toHaveLength(1);
    expect(port.messages[0].dedupeKey).toBe(outboxRow(fixture).dedupeKey);
    expect(port.messages[0].recipient).toBe('customer:customer-demo');
    expect(outboxRow(fixture).status).toBe('SENT');
    expect(outboxRow(fixture).sentAt).not.toBeNull();
    expect(outboxRow(fixture).lastError).toBeNull();
  });

  it('keeps a failed row retryable and marks it FAILED after the attempt budget', async () => {
    const port = new RecordingNotificationPort();
    port.failAlways();
    const { fixture, dispatcher } = createDispatcher({ port, maxAttempts: 3 });
    await seedConfirmedIntent(fixture);

    const first = await dispatcher.runBatch();
    expect(first).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
    expect(outboxRow(fixture).status).toBe('PENDING');
    expect(outboxRow(fixture).attempts).toBe(1);
    expect(outboxRow(fixture).lastError).toContain('notification provider unavailable');

    await dispatcher.runBatch();
    expect(outboxRow(fixture).status).toBe('PENDING');
    expect(outboxRow(fixture).attempts).toBe(2);

    const third = await dispatcher.runBatch();
    expect(third).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
    expect(outboxRow(fixture).status).toBe('FAILED');
    expect(outboxRow(fixture).attempts).toBe(3);

    // FAILED rows are never claimed again.
    const fourth = await dispatcher.runBatch();
    expect(fourth).toEqual({ claimed: 0, sent: 0, retried: 0, failed: 0 });
  });

  it('retries successfully after transient failures', async () => {
    const port = new RecordingNotificationPort({ failuresRemaining: 2 });
    const { fixture, dispatcher } = createDispatcher({ port });
    await seedConfirmedIntent(fixture);

    await dispatcher.runBatch();
    expect(outboxRow(fixture).status).toBe('PENDING');
    await dispatcher.runBatch();
    expect(outboxRow(fixture).status).toBe('PENDING');
    await dispatcher.runBatch();

    expect(outboxRow(fixture).status).toBe('SENT');
    expect(outboxRow(fixture).attempts).toBe(2);
    expect(port.messages).toHaveLength(3);
    expect(outboxRow(fixture).lastError).toBeNull();
  });

  it('claims at most 50 rows per batch', async () => {
    const port = new RecordingNotificationPort();
    const { fixture, dispatcher } = createDispatcher({ port });
    for (let index = 0; index < 55; index += 1) {
      fixture.store.state.outbox.push(makePendingRow(index));
    }

    const result = await dispatcher.runBatch();

    expect(result.claimed).toBe(50);
    expect(port.messages).toHaveLength(50);
    expect(fixture.store.state.outbox.filter((row) => row.status === 'PENDING')).toHaveLength(5);
  });

  it('polls while started and stops polling after stop()', async () => {
    const port = new RecordingNotificationPort();
    const { fixture, dispatcher } = createDispatcher({ port, pollIntervalMs: 5 });
    await seedConfirmedIntent(fixture);

    dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await dispatcher.stop();
    const delivered = port.messages.length;
    expect(delivered).toBeGreaterThanOrEqual(1);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(port.messages).toHaveLength(delivered);

    // stop() is idempotent and start() after stop() must not restart the loop.
    await dispatcher.stop();
    dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(port.messages).toHaveLength(delivered);
  });
});
