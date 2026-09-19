import { describe, expect, it } from 'vitest';
import { InsufficientInventoryError, ProductNotFoundError, ValidationError } from '../../../src/domain/errors';
import { ESPRESSO, GRINDER, PITCHER, createUnitFixture } from '../../helpers/unit-fixture';

describe('CreateOrder use case (in-memory fakes)', () => {
  it('creates a CONFIRMED order with computed totals, one decrement per line, and one ORDER_CONFIRMED intent', async () => {
    const fixture = createUnitFixture();

    const order = await fixture.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [
        { productId: ESPRESSO, quantity: 1 },
        { productId: GRINDER, quantity: 1 },
      ],
    });

    expect(order.status).toBe('CONFIRMED');
    expect(order.customerId).toBe('customer-demo');
    expect(order.totalCents).toBe(24999 + 8999);
    expect(order.currency).toBe('USD');
    expect(order.createdAt).toBe('2026-09-19T10:15:30.000Z');
    expect(order.shippedAt).toBeNull();
    expect(order.cancelledAt).toBeNull();
    // Items are reported in ascending productId order (same order as the SQL reads).
    expect(order.items).toEqual([
      {
        productId: GRINDER,
        productName: 'Burr Coffee Grinder',
        quantity: 1,
        unitPriceCents: 8999,
        lineTotalCents: 8999,
      },
      {
        productId: ESPRESSO,
        productName: 'Espresso Machine',
        quantity: 1,
        unitPriceCents: 24999,
        lineTotalCents: 24999,
      },
    ]);

    expect(fixture.calls.decrements).toEqual([
      { productId: ESPRESSO, quantity: 1 },
      { productId: GRINDER, quantity: 1 },
    ]);
    expect(fixture.store.availableQuantity(ESPRESSO)).toBe(4);
    expect(fixture.store.availableQuantity(GRINDER)).toBe(9);

    expect(fixture.store.state.outbox).toHaveLength(1);
    const outbox = fixture.store.state.outbox[0];
    expect(outbox.type).toBe('ORDER_CONFIRMED');
    expect(outbox.status).toBe('PENDING');
    expect(outbox.dedupeKey).toBe(`order:${order.id}:confirmed`);
    expect(outbox.payload).toMatchObject({
      type: 'ORDER_CONFIRMED',
      orderId: order.id,
      customerId: 'customer-demo',
      recipient: 'customer:customer-demo',
      template: 'order-confirmed',
      dedupeKey: `order:${order.id}:confirmed`,
      data: { status: 'CONFIRMED', totalCents: 33998, currency: 'USD' },
    });
    expect(fixture.unitOfWork.commits).toBe(1);
  });

  it('rejects an order that exceeds available inventory without any side effect', async () => {
    const fixture = createUnitFixture();
    const before = fixture.store.snapshot();

    await expect(
      fixture.useCases.createOrder.execute({
        customerId: 'customer-demo',
        items: [{ productId: ESPRESSO, quantity: 6 }],
      }),
    ).rejects.toBeInstanceOf(InsufficientInventoryError);

    await expect(
      fixture.useCases.createOrder.execute({
        customerId: 'customer-demo',
        items: [{ productId: ESPRESSO, quantity: 6 }],
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_INVENTORY',
      details: { productId: ESPRESSO, requested: 6, available: 5 },
    });

    expect(fixture.store.state).toEqual(before);
    expect(fixture.store.availableQuantity(ESPRESSO)).toBe(5);
    expect(fixture.calls.decrements).toHaveLength(0);
    expect(fixture.store.state.orders).toHaveLength(0);
    expect(fixture.store.state.outbox).toHaveLength(0);
    expect(fixture.unitOfWork.rollbacks).toBe(2);
  });

  it('rejects a partially available multi-line order without writing anything', async () => {
    const fixture = createUnitFixture();
    const before = fixture.store.snapshot();

    await expect(
      fixture.useCases.createOrder.execute({
        customerId: 'customer-demo',
        items: [
          { productId: PITCHER, quantity: 1 },
          { productId: ESPRESSO, quantity: 5 },
          { productId: GRINDER, quantity: 11 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_INVENTORY', details: { productId: GRINDER } });

    expect(fixture.store.state).toEqual(before);
  });

  it('rejects an unknown product with PRODUCT_NOT_FOUND and no side effect', async () => {
    const fixture = createUnitFixture();
    const before = fixture.store.snapshot();

    await expect(
      fixture.useCases.createOrder.execute({
        customerId: 'customer-demo',
        items: [{ productId: 'prod-does-not-exist', quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(ProductNotFoundError);

    expect(fixture.store.state).toEqual(before);
  });

  it('locks inventory rows in ascending product order', async () => {
    const fixture = createUnitFixture();

    await fixture.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [
        { productId: PITCHER, quantity: 1 },
        { productId: ESPRESSO, quantity: 1 },
      ],
    });

    // The repository sorts before locking; the use case hands over the request order.
    expect(fixture.calls.locks).toEqual([[PITCHER, ESPRESSO]]);
  });

  it.each([
    ['missing customerId', { items: [{ productId: ESPRESSO, quantity: 1 }] }],
    ['blank customerId', { customerId: '   ', items: [{ productId: ESPRESSO, quantity: 1 }] }],
    ['missing items', { customerId: 'customer-demo' }],
    ['empty items', { customerId: 'customer-demo', items: [] }],
    ['quantity 0', { customerId: 'customer-demo', items: [{ productId: ESPRESSO, quantity: 0 }] }],
    ['negative quantity', { customerId: 'customer-demo', items: [{ productId: ESPRESSO, quantity: -1 }] }],
    ['fractional quantity', { customerId: 'customer-demo', items: [{ productId: ESPRESSO, quantity: 1.5 }] }],
    ['string quantity', { customerId: 'customer-demo', items: [{ productId: ESPRESSO, quantity: '1' }] }],
    [
      'duplicate productId',
      {
        customerId: 'customer-demo',
        items: [
          { productId: ESPRESSO, quantity: 1 },
          { productId: ESPRESSO, quantity: 2 },
        ],
      },
    ],
  ])('rejects %s with VALIDATION_ERROR and no side effect', async (_label, payload) => {
    const fixture = createUnitFixture();
    const before = fixture.store.snapshot();

    await expect(fixture.useCases.createOrder.execute(payload as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(fixture.useCases.createOrder.execute(payload as never)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    expect(fixture.store.state).toEqual(before);
    expect(fixture.store.state.orders).toHaveLength(0);
    expect(fixture.store.availableQuantity(ESPRESSO)).toBe(5);
  });
});
