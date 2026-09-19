import { describe, expect, it } from 'vitest';
import {
  InvalidCancellationReasonError,
  OrderAlreadyShippedError,
  OrderNotFoundError,
} from '../../../src/domain/errors';
import { ESPRESSO, GRINDER, createUnitFixture } from '../../helpers/unit-fixture';

describe('CancelOrder use case (in-memory fakes)', () => {
  it('cancels a CONFIRMED order: sets status/cancelledAt/reason, restores inventory once, records one ORDER_CANCELLED intent', async () => {
    const fixture = createUnitFixture();
    const order = await fixture.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [
        { productId: ESPRESSO, quantity: 2 },
        { productId: GRINDER, quantity: 1 },
      ],
    });
    expect(fixture.store.availableQuantity(ESPRESSO)).toBe(3);

    const cancelled = await fixture.useCases.cancelOrder.execute(order.id, '  Wrong size  ');

    expect(cancelled.id).toBe(order.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellationReason).toBe('Wrong size');
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.shippedAt).toBeNull();

    // Exactly one restore per order item; the order of the reads is implementation detail.
    expect(
      [...fixture.calls.increments].sort((left, right) =>
        left.productId.localeCompare(right.productId),
      ),
    ).toEqual([
      { productId: GRINDER, quantity: 1 },
      { productId: ESPRESSO, quantity: 2 },
    ]);
    expect(fixture.calls.increments).toHaveLength(2);
    expect(fixture.store.availableQuantity(ESPRESSO)).toBe(5);
    expect(fixture.store.availableQuantity(GRINDER)).toBe(10);

    const cancellationIntents = fixture.store.state.outbox.filter(
      (row) => row.type === 'ORDER_CANCELLED',
    );
    expect(cancellationIntents).toHaveLength(1);
    expect(cancellationIntents[0].dedupeKey).toBe(`order:${order.id}:cancelled`);
    expect(cancellationIntents[0].status).toBe('PENDING');
    expect(cancellationIntents[0].payload.data).toMatchObject({
      status: 'CANCELLED',
      cancellationReason: 'Wrong size',
    });
    expect(fixture.store.state.outbox).toHaveLength(2);
  });

  it('returns the stored result on a repeated cancellation without touching inventory or the outbox', async () => {
    const fixture = createUnitFixture();
    const order = await fixture.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    const first = await fixture.useCases.cancelOrder.execute(order.id, 'first reason');
    const incrementsAfterFirst = [...fixture.calls.increments];
    const outboxAfterFirst = fixture.store.state.outbox.length;
    const inventoryAfterFirst = fixture.store.availableQuantity(ESPRESSO);

    const second = await fixture.useCases.cancelOrder.execute(order.id, 'second reason');

    expect(second.cancelledAt).toBe(first.cancelledAt);
    expect(second.cancellationReason).toBe('first reason');
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(fixture.calls.increments).toEqual(incrementsAfterFirst);
    expect(fixture.store.state.outbox).toHaveLength(outboxAfterFirst);
    expect(fixture.store.availableQuantity(ESPRESSO)).toBe(inventoryAfterFirst);
  });

  it('rejects cancellation of a SHIPPED order and writes nothing', async () => {
    const fixture = createUnitFixture();
    const order = await fixture.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });
    await fixture.useCases.shipOrder.execute(order.id);

    const before = fixture.store.snapshot();
    await expect(
      fixture.useCases.cancelOrder.execute(order.id, 'too late'),
    ).rejects.toBeInstanceOf(OrderAlreadyShippedError);
    await expect(fixture.useCases.cancelOrder.execute(order.id, 'too late')).rejects.toMatchObject({
      code: 'ORDER_ALREADY_SHIPPED',
    });

    expect(fixture.store.state).toEqual(before);
    expect(fixture.calls.increments).toHaveLength(0);
  });

  it('rejects an unknown order with ORDER_NOT_FOUND', async () => {
    const fixture = createUnitFixture();
    await expect(
      fixture.useCases.cancelOrder.execute('order-missing', 'whatever'),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it.each([['', 'empty'], ['   ', 'whitespace only'], ['a'.repeat(201), '201 characters']])(
    'rejects a reason of %s (%s) with INVALID_CANCELLATION_REASON and writes nothing',
    async (reason) => {
      const fixture = createUnitFixture();
      const order = await fixture.useCases.createOrder.execute({
        customerId: 'customer-demo',
        items: [{ productId: ESPRESSO, quantity: 1 }],
      });
      const before = fixture.store.snapshot();

      await expect(
        fixture.useCases.cancelOrder.execute(order.id, reason),
      ).rejects.toBeInstanceOf(InvalidCancellationReasonError);
      await expect(fixture.useCases.cancelOrder.execute(order.id, reason)).rejects.toMatchObject({
        code: 'INVALID_CANCELLATION_REASON',
      });

      expect(fixture.store.state).toEqual(before);
      expect(fixture.store.state.orders[0].status).toBe('CONFIRMED');
      expect(fixture.store.availableQuantity(ESPRESSO)).toBe(4);
      expect(fixture.store.state.outbox).toHaveLength(1);
    },
  );

  it('accepts a reason of exactly 200 characters', async () => {
    const fixture = createUnitFixture();
    const order = await fixture.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    const reason = 'c'.repeat(200);
    const cancelled = await fixture.useCases.cancelOrder.execute(order.id, reason);

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellationReason).toHaveLength(200);
    expect(cancelled.cancellationReason).toBe(reason);
  });
});
