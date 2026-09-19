import { describe, expect, it } from 'vitest';
import { OrderAlreadyCancelledError, OrderNotFoundError } from '../../../src/domain/errors';
import { ESPRESSO, createUnitFixture } from '../../helpers/unit-fixture';

describe('ShipOrder use case (in-memory fakes)', () => {
  it('marks a CONFIRMED order SHIPPED and sets shippedAt', async () => {
    const fixture = createUnitFixture();
    const order = await fixture.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    const shipped = await fixture.useCases.shipOrder.execute(order.id);

    expect(shipped.status).toBe('SHIPPED');
    expect(shipped.shippedAt).toBe('2026-09-19T10:15:31.000Z');
    expect(shipped.cancelledAt).toBeNull();
    expect(shipped.cancellationReason).toBeNull();
    expect(fixture.store.state.orders[0].status).toBe('SHIPPED');
    // Shipping changes no inventory and records no notification intent.
    expect(fixture.calls.decrements).toHaveLength(1);
    expect(fixture.calls.increments).toHaveLength(0);
    expect(fixture.store.state.outbox).toHaveLength(1);
    expect(fixture.store.state.outbox[0].type).toBe('ORDER_CONFIRMED');
  });

  it('is idempotent: repeating the action returns the original shippedAt and writes nothing', async () => {
    const fixture = createUnitFixture();
    const order = await fixture.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    const first = await fixture.useCases.shipOrder.execute(order.id);
    const before = fixture.store.snapshot();

    const second = await fixture.useCases.shipOrder.execute(order.id);

    expect(second.shippedAt).toBe(first.shippedAt);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(fixture.store.state).toEqual(before);
  });

  it('rejects shipping a CANCELLED order and writes nothing', async () => {
    const fixture = createUnitFixture();
    const order = await fixture.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });
    await fixture.useCases.cancelOrder.execute(order.id, 'changed my mind');

    const before = fixture.store.snapshot();
    await expect(fixture.useCases.shipOrder.execute(order.id)).rejects.toBeInstanceOf(
      OrderAlreadyCancelledError,
    );

    expect(fixture.store.state).toEqual(before);
    expect(fixture.store.state.orders[0].status).toBe('CANCELLED');
  });

  it('rejects an unknown order with ORDER_NOT_FOUND', async () => {
    const fixture = createUnitFixture();
    await expect(fixture.useCases.shipOrder.execute('order-missing')).rejects.toBeInstanceOf(
      OrderNotFoundError,
    );
  });
});
