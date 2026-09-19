import { describe, expect, it } from 'vitest';
import {
  lineTotalCents,
  orderTotalCents,
  planShipment,
  toOrderView,
  type Order,
  type OrderItem,
} from '../../../src/domain/model/order';
import { toProductView } from '../../../src/domain/model/product';
import { makeProduct } from '../../helpers/fakes';

const ORDER: Order = {
  id: 'order-1',
  customerId: 'customer-demo',
  status: 'CONFIRMED',
  totalCents: 33998,
  currency: 'USD',
  createdAt: new Date('2026-09-19T10:15:30.000Z'),
  updatedAt: new Date('2026-09-19T10:15:30.000Z'),
  shippedAt: null,
  cancelledAt: null,
  cancellationReason: null,
};

const ITEM: OrderItem = {
  id: 'item-1',
  orderId: 'order-1',
  productId: 'prod-espresso-machine',
  productName: 'Espresso Machine',
  quantity: 1,
  unitPriceCents: 24999,
  lineTotalCents: 24999,
};

describe('order totals', () => {
  it('computes line totals as unit price times quantity', () => {
    expect(lineTotalCents(8999, 3)).toBe(26997);
  });

  it('sums all line totals into the order total', () => {
    expect(
      orderTotalCents([
        { unitPriceCents: 24999, quantity: 1 },
        { unitPriceCents: 8999, quantity: 1 },
      ]),
    ).toBe(33998);
  });
});

describe('order view mapping', () => {
  it('renders ISO-8601 timestamps and null for absent state fields', () => {
    const view = toOrderView(ORDER, [ITEM]);
    expect(view).toEqual({
      id: 'order-1',
      customerId: 'customer-demo',
      status: 'CONFIRMED',
      totalCents: 33998,
      currency: 'USD',
      createdAt: '2026-09-19T10:15:30.000Z',
      updatedAt: '2026-09-19T10:15:30.000Z',
      shippedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      items: [
        {
          productId: 'prod-espresso-machine',
          productName: 'Espresso Machine',
          quantity: 1,
          unitPriceCents: 24999,
          lineTotalCents: 24999,
        },
      ],
    });
  });

  it('renders shippedAt and cancelledAt when present', () => {
    const shipped = toOrderView(
      { ...ORDER, status: 'SHIPPED', shippedAt: new Date('2026-09-19T11:00:00.000Z') },
      [ITEM],
    );
    expect(shipped.shippedAt).toBe('2026-09-19T11:00:00.000Z');

    const cancelled = toOrderView(
      {
        ...ORDER,
        status: 'CANCELLED',
        cancelledAt: new Date('2026-09-19T12:00:00.000Z'),
        cancellationReason: 'wrong size',
      },
      [ITEM],
    );
    expect(cancelled.cancelledAt).toBe('2026-09-19T12:00:00.000Z');
    expect(cancelled.cancellationReason).toBe('wrong size');
  });
});

describe('shipment policy (order state machine)', () => {
  it('proceeds for CONFIRMED orders (CONFIRMED -> SHIPPED)', () => {
    expect(planShipment({ status: 'CONFIRMED' })).toEqual({ type: 'PROCEED' });
  });

  it('is idempotent for already SHIPPED orders', () => {
    expect(planShipment({ status: 'SHIPPED' })).toEqual({ type: 'ALREADY_SHIPPED' });
  });

  it('rejects shipping a CANCELLED order', () => {
    expect(planShipment({ status: 'CANCELLED' })).toEqual({ type: 'REJECT_CANCELLED' });
  });
});

describe('product view mapping', () => {
  it('maps a product with its availability', () => {
    expect(
      toProductView({
        product: makeProduct({ id: 'prod-1', name: 'Widget', priceCents: 500 }),
        availableQuantity: 7,
      }),
    ).toEqual({
      id: 'prod-1',
      sku: 'PROD-1',
      name: 'Widget',
      description: '',
      priceCents: 500,
      currency: 'USD',
      availableQuantity: 7,
    });
  });
});
