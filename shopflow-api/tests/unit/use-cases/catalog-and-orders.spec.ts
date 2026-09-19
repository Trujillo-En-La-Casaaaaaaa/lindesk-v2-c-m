import { describe, expect, it } from 'vitest';
import { OrderNotFoundError, ProductNotFoundError, ValidationError } from '../../../src/domain/errors';
import { ESPRESSO, GRINDER, PITCHER, createUnitFixture } from '../../helpers/unit-fixture';

describe('ListProducts use case (in-memory fakes)', () => {
  it('lists the catalog ordered by name ascending with available inventory', async () => {
    const fixture = createUnitFixture();
    const products = await fixture.useCases.listProducts.execute();

    expect(products.map((product) => product.name)).toEqual([
      'Burr Coffee Grinder',
      'Espresso Machine',
      'Milk Pitcher',
    ]);
    expect(products.map((product) => product.id)).toEqual([GRINDER, ESPRESSO, PITCHER]);
    expect(products.map((product) => product.availableQuantity)).toEqual([10, 5, 25]);
    expect(products[0].priceCents).toBe(8999);
    expect(products[0].currency).toBe('USD');
  });

  it('returns a single product with its availability', async () => {
    const fixture = createUnitFixture();
    const product = await fixture.useCases.listProducts.getById(ESPRESSO);
    expect(product).toMatchObject({
      id: ESPRESSO,
      name: 'Espresso Machine',
      priceCents: 24999,
      availableQuantity: 5,
    });
  });

  it('rejects an unknown product with PRODUCT_NOT_FOUND', async () => {
    const fixture = createUnitFixture();
    await expect(fixture.useCases.listProducts.getById('prod-nope')).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );
  });

  it('rejects a blank product id with VALIDATION_ERROR', async () => {
    const fixture = createUnitFixture();
    await expect(fixture.useCases.listProducts.getById('   ')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('GetOrder and ListOrders use cases (in-memory fakes)', () => {
  it('returns an order detail view including items', async () => {
    const fixture = createUnitFixture();
    const created = await fixture.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 2 }],
    });

    const detail = await fixture.useCases.getOrder.execute(created.id);
    expect(detail).toEqual(created);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].lineTotalCents).toBe(49998);
  });

  it('rejects an unknown order with ORDER_NOT_FOUND', async () => {
    const fixture = createUnitFixture();
    await expect(fixture.useCases.getOrder.execute('order-missing')).rejects.toBeInstanceOf(
      OrderNotFoundError,
    );
  });

  it('lists orders newest first and honours the limit', async () => {
    const fixture = createUnitFixture();
    const first = await fixture.useCases.createOrder.execute({
      customerId: 'customer-1',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });
    const second = await fixture.useCases.createOrder.execute({
      customerId: 'customer-2',
      items: [{ productId: GRINDER, quantity: 1 }],
    });
    const third = await fixture.useCases.createOrder.execute({
      customerId: 'customer-3',
      items: [{ productId: PITCHER, quantity: 1 }],
    });

    const all = await fixture.useCases.listOrders.execute();
    expect(all.map((order) => order.id)).toEqual([third.id, second.id, first.id]);

    const limited = await fixture.useCases.listOrders.execute(1);
    expect(limited.map((order) => order.id)).toEqual([third.id]);
  });

  it.each([[0], [-1], [201], [1.5], ['abc']])(
    'rejects limit %s with VALIDATION_ERROR',
    async (limit) => {
      const fixture = createUnitFixture();
      await expect(fixture.useCases.listOrders.execute(limit as number)).rejects.toBeInstanceOf(
        ValidationError,
      );
    },
  );

  it('accepts the maximum limit of 200', async () => {
    const fixture = createUnitFixture();
    await expect(fixture.useCases.listOrders.execute(200)).resolves.toEqual([]);
  });
});
