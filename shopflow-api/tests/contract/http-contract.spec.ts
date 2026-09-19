import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Container } from '../../src/composition/container';
import { createTestContainer } from '../helpers/app';
import { createTestPool, ensureSchema, resetDatabase } from '../helpers/database';

const ESPRESSO = 'prod-espresso-machine';
const GRINDER = 'prod-burr-grinder';
const PITCHER = 'prod-milk-pitcher';

const PRODUCT_KEYS = [
  'id',
  'sku',
  'name',
  'description',
  'priceCents',
  'currency',
  'availableQuantity',
] as const;

const ORDER_KEYS = [
  'id',
  'customerId',
  'status',
  'totalCents',
  'currency',
  'createdAt',
  'updatedAt',
  'shippedAt',
  'cancelledAt',
  'cancellationReason',
  'items',
] as const;

const ORDER_ITEM_KEYS = [
  'productId',
  'productName',
  'quantity',
  'unitPriceCents',
  'lineTotalCents',
] as const;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface ErrorEnvelope {
  error: { code: string; message: string; details: Record<string, unknown> };
}

function expectErrorEnvelope(body: unknown, code: string): ErrorEnvelope {
  const envelope = body as ErrorEnvelope;
  expect(Object.keys(envelope)).toEqual(['error']);
  expect(envelope.error.code).toBe(code);
  expect(typeof envelope.error.message).toBe('string');
  expect(envelope.error.message.length).toBeGreaterThan(0);
  expect(envelope.error.details).toBeTypeOf('object');
  return envelope;
}

function expectProductView(product: Record<string, unknown>): void {
  expect(Object.keys(product).sort()).toEqual([...PRODUCT_KEYS].sort());
  expect(typeof product['id']).toBe('string');
  expect(typeof product['sku']).toBe('string');
  expect(typeof product['name']).toBe('string');
  expect(typeof product['description']).toBe('string');
  expect(Number.isInteger(product['priceCents'])).toBe(true);
  expect(typeof product['currency']).toBe('string');
  expect(Number.isInteger(product['availableQuantity'])).toBe(true);
}

function expectOrderView(order: Record<string, unknown>): void {
  expect(Object.keys(order).sort()).toEqual([...ORDER_KEYS].sort());
  expect(typeof order['id']).toBe('string');
  expect(typeof order['customerId']).toBe('string');
  expect(['CONFIRMED', 'SHIPPED', 'CANCELLED']).toContain(order['status']);
  expect(Number.isInteger(order['totalCents'])).toBe(true);
  expect(typeof order['currency']).toBe('string');
  expect(String(order['createdAt'])).toMatch(ISO_UTC);
  expect(String(order['updatedAt'])).toMatch(ISO_UTC);
  expect(order['shippedAt'] === null || ISO_UTC.test(String(order['shippedAt']))).toBe(true);
  expect(order['cancelledAt'] === null || ISO_UTC.test(String(order['cancelledAt']))).toBe(true);
  expect(
    order['cancellationReason'] === null || typeof order['cancellationReason'] === 'string',
  ).toBe(true);

  const items = order['items'] as Array<Record<string, unknown>>;
  expect(Array.isArray(items)).toBe(true);
  for (const item of items) {
    expect(Object.keys(item).sort()).toEqual([...ORDER_ITEM_KEYS].sort());
    expect(typeof item['productId']).toBe('string');
    expect(typeof item['productName']).toBe('string');
    expect(Number.isInteger(item['quantity'])).toBe(true);
    expect(Number.isInteger(item['unitPriceCents'])).toBe(true);
    expect(Number.isInteger(item['lineTotalCents'])).toBe(true);
  }
}

describe('HTTP contract (frozen API_CONTRACT.md) against real PostgreSQL 16', () => {
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

  async function createOrder(
    items: Array<{ productId: string; quantity: number }>,
    customerId = 'customer-demo',
  ): Promise<Record<string, unknown>> {
    const response = await request(container.app)
      .post('/api/orders')
      .send({ customerId, items })
      .expect(201);
    return response.body.order as Record<string, unknown>;
  }

  describe('GET /health', () => {
    it('reports ok with database up', async () => {
      const response = await request(container.app).get('/health').expect(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toEqual({ status: 'ok', database: 'up' });
    });
  });

  describe('GET /api/products', () => {
    it('returns the seeded catalog ordered by name with available inventory', async () => {
      const response = await request(container.app).get('/api/products').expect(200);

      expect(Object.keys(response.body)).toEqual(['products']);
      const products = response.body.products as Array<Record<string, unknown>>;
      expect(products).toHaveLength(4);
      products.forEach(expectProductView);
      expect(products.map((product) => product['name'])).toEqual([
        'Burr Coffee Grinder',
        'Espresso Machine',
        'Milk Pitcher',
        'Single Origin Coffee Beans 1 kg',
      ]);
      expect(products.map((product) => product['id'])).toEqual([
        'prod-burr-grinder',
        'prod-espresso-machine',
        'prod-milk-pitcher',
        'prod-coffee-beans-1kg',
      ]);

      const espresso = products.find((product) => product['id'] === ESPRESSO);
      expect(espresso).toMatchObject({
        sku: 'SF-ESP-001',
        priceCents: 24999,
        currency: 'USD',
        availableQuantity: 5,
      });
    });
  });

  describe('GET /api/products/:id', () => {
    it('returns one product view', async () => {
      const response = await request(container.app).get(`/api/products/${ESPRESSO}`).expect(200);
      expect(Object.keys(response.body)).toEqual(['product']);
      const product = response.body.product as Record<string, unknown>;
      expectProductView(product);
      expect(product).toMatchObject({
        id: ESPRESSO,
        sku: 'SF-ESP-001',
        name: 'Espresso Machine',
        description: 'Semi-automatic espresso machine with steam wand.',
        priceCents: 24999,
        currency: 'USD',
        availableQuantity: 5,
      });
    });

    it('returns 404 PRODUCT_NOT_FOUND for an unknown product', async () => {
      const response = await request(container.app).get('/api/products/prod-nope').expect(404);
      expectErrorEnvelope(response.body, 'PRODUCT_NOT_FOUND');
    });
  });

  describe('POST /api/orders', () => {
    it('creates a CONFIRMED order, decrements inventory, and returns the order view', async () => {
      const response = await request(container.app)
        .post('/api/orders')
        .send({
          customerId: 'customer-demo',
          items: [
            { productId: ESPRESSO, quantity: 1 },
            { productId: GRINDER, quantity: 1 },
          ],
        })
        .expect(201);

      const order = response.body.order as Record<string, unknown>;
      expectOrderView(order);
      expect(order).toMatchObject({
        customerId: 'customer-demo',
        status: 'CONFIRMED',
        totalCents: 24999 + 8999,
        currency: 'USD',
        shippedAt: null,
        cancelledAt: null,
        cancellationReason: null,
      });
      // Items are always reported in ascending productId order.
      expect(order['items']).toEqual([
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

      const inventory = await request(container.app).get('/api/products').expect(200);
      const products = inventory.body.products as Array<Record<string, unknown>>;
      expect(products.find((product) => product['id'] === ESPRESSO)?.['availableQuantity']).toBe(4);
      expect(products.find((product) => product['id'] === GRINDER)?.['availableQuantity']).toBe(9);

      const detail = await request(container.app)
        .get(`/api/orders/${String(order['id'])}`)
        .expect(200);
      expect(detail.body.order).toEqual(order);
    });

    it.each([
      ['missing customerId', { items: [{ productId: ESPRESSO, quantity: 1 }] }],
      ['blank customerId', { customerId: '   ', items: [{ productId: ESPRESSO, quantity: 1 }] }],
      ['missing items', { customerId: 'customer-demo' }],
      ['empty items', { customerId: 'customer-demo', items: [] }],
      ['zero quantity', { customerId: 'customer-demo', items: [{ productId: ESPRESSO, quantity: 0 }] }],
      [
        'non-integer quantity',
        { customerId: 'customer-demo', items: [{ productId: ESPRESSO, quantity: 1.5 }] },
      ],
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
      [
        'missing productId',
        { customerId: 'customer-demo', items: [{ quantity: 1 }] },
      ],
    ])('returns 400 VALIDATION_ERROR for %s', async (_label, payload) => {
      const response = await request(container.app).post('/api/orders').send(payload).expect(400);
      expectErrorEnvelope(response.body, 'VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for a malformed JSON body', async () => {
      const response = await request(container.app)
        .post('/api/orders')
        .set('content-type', 'application/json')
        .send('{"customerId": ')
        .expect(400);
      expectErrorEnvelope(response.body, 'VALIDATION_ERROR');
    });

    it('returns 404 PRODUCT_NOT_FOUND and writes nothing', async () => {
      const response = await request(container.app)
        .post('/api/orders')
        .send({ customerId: 'customer-demo', items: [{ productId: 'prod-nope', quantity: 1 }] })
        .expect(404);
      expectErrorEnvelope(response.body, 'PRODUCT_NOT_FOUND');

      const orders = await request(container.app).get('/api/orders').expect(200);
      expect(orders.body.orders).toEqual([]);
    });

    it('returns 409 INSUFFICIENT_INVENTORY with details and writes nothing', async () => {
      const response = await request(container.app)
        .post('/api/orders')
        .send({ customerId: 'customer-demo', items: [{ productId: ESPRESSO, quantity: 5 }] })
        .expect(201);
      expect(response.body.order.status).toBe('CONFIRMED');

      const failed = await request(container.app)
        .post('/api/orders')
        .send({ customerId: 'customer-demo', items: [{ productId: ESPRESSO, quantity: 1 }] })
        .expect(409);
      const envelope = expectErrorEnvelope(failed.body, 'INSUFFICIENT_INVENTORY');
      expect(envelope.error.details).toEqual({
        productId: ESPRESSO,
        requested: 1,
        available: 0,
      });

      const orders = await request(container.app).get('/api/orders').expect(200);
      expect(orders.body.orders).toHaveLength(1);
    });
  });

  describe('GET /api/orders', () => {
    it('lists orders newest first and supports the limit parameter', async () => {
      const first = await createOrder([{ productId: PITCHER, quantity: 1 }], 'customer-1');
      const second = await createOrder([{ productId: GRINDER, quantity: 1 }], 'customer-2');

      const all = await request(container.app).get('/api/orders').expect(200);
      expect(Object.keys(all.body)).toEqual(['orders']);
      expect((all.body.orders as Array<Record<string, unknown>>).map((order) => order['id'])).toEqual([
        second['id'],
        first['id'],
      ]);

      const limited = await request(container.app).get('/api/orders?limit=1').expect(200);
      expect((limited.body.orders as Array<Record<string, unknown>>).length).toBe(1);
      expect((limited.body.orders as Array<Record<string, unknown>>)[0]['id']).toBe(second['id']);

      const max = await request(container.app).get('/api/orders?limit=200').expect(200);
      expect((max.body.orders as unknown[]).length).toBe(2);
    });

    it.each([['0'], ['201'], ['abc'], ['-1'], ['1.5'], ['']])(
      'returns 400 VALIDATION_ERROR for limit=%s',
      async (limit) => {
        const response = await request(container.app)
          .get(`/api/orders?limit=${limit}`)
          .expect(400);
        expectErrorEnvelope(response.body, 'VALIDATION_ERROR');
      },
    );
  });

  describe('GET /api/orders/:id', () => {
    it('returns the order detail and 404 for an unknown order', async () => {
      const order = await createOrder([{ productId: ESPRESSO, quantity: 1 }]);
      const detail = await request(container.app)
        .get(`/api/orders/${String(order['id'])}`)
        .expect(200);
      expect(detail.body.order).toEqual(order);

      const missing = await request(container.app).get('/api/orders/order-nope').expect(404);
      const envelope = expectErrorEnvelope(missing.body, 'ORDER_NOT_FOUND');
      expect(envelope.error.details).toEqual({ orderId: 'order-nope' });
    });
  });

  describe('POST /api/orders/:id/cancel', () => {
    it('cancels a CONFIRMED order, restores inventory, and is a no-op when repeated', async () => {
      const order = await createOrder([{ productId: ESPRESSO, quantity: 2 }]);
      const orderId = String(order['id']);

      const cancelled = await request(container.app)
        .post(`/api/orders/${orderId}/cancel`)
        .send({ reason: '  Ordered the wrong size  ' })
        .expect(200);
      const cancelledOrder = cancelled.body.order as Record<string, unknown>;
      expectOrderView(cancelledOrder);
      expect(cancelledOrder).toMatchObject({
        id: orderId,
        status: 'CANCELLED',
        cancellationReason: 'Ordered the wrong size',
      });
      expect(cancelledOrder['cancelledAt']).not.toBeNull();

      const inventory = await request(container.app).get(`/api/products/${ESPRESSO}`).expect(200);
      expect(inventory.body.product.availableQuantity).toBe(5);

      const repeated = await request(container.app)
        .post(`/api/orders/${orderId}/cancel`)
        .send({ reason: 'a different reason' })
        .expect(200);
      expect(repeated.body.order.cancelledAt).toBe(cancelledOrder['cancelledAt']);
      expect(repeated.body.order.cancellationReason).toBe('Ordered the wrong size');

      const afterRepeat = await request(container.app).get(`/api/products/${ESPRESSO}`).expect(200);
      expect(afterRepeat.body.product.availableQuantity).toBe(5);
    });

    it.each([['empty', ''], ['whitespace', '   '], ['201 characters', 'z'.repeat(201)], ['missing', undefined]])(
      'returns 400 INVALID_CANCELLATION_REASON for a %s reason',
      async (_label, reason) => {
        const order = await createOrder([{ productId: ESPRESSO, quantity: 1 }]);
        const orderId = String(order['id']);

        const response = await request(container.app)
          .post(`/api/orders/${orderId}/cancel`)
          .send(reason === undefined ? {} : { reason })
          .expect(400);
        expectErrorEnvelope(response.body, 'INVALID_CANCELLATION_REASON');

        const detail = await request(container.app).get(`/api/orders/${orderId}`).expect(200);
        expect(detail.body.order.status).toBe('CONFIRMED');
      },
    );

    it('accepts a reason of exactly 200 characters', async () => {
      const order = await createOrder([{ productId: ESPRESSO, quantity: 1 }]);
      const reason = 'q'.repeat(200);

      const response = await request(container.app)
        .post(`/api/orders/${String(order['id'])}/cancel`)
        .send({ reason })
        .expect(200);
      expect(response.body.order).toMatchObject({ status: 'CANCELLED', cancellationReason: reason });
    });

    it('returns 404 ORDER_NOT_FOUND for an unknown order', async () => {
      const response = await request(container.app)
        .post('/api/orders/order-nope/cancel')
        .send({ reason: 'nope' })
        .expect(404);
      expectErrorEnvelope(response.body, 'ORDER_NOT_FOUND');
    });

    it('returns 409 ORDER_ALREADY_SHIPPED for a shipped order', async () => {
      const order = await createOrder([{ productId: ESPRESSO, quantity: 1 }]);
      const orderId = String(order['id']);
      await request(container.app).post(`/api/orders/${orderId}/ship`).send({}).expect(200);

      const response = await request(container.app)
        .post(`/api/orders/${orderId}/cancel`)
        .send({ reason: 'too late' })
        .expect(409);
      expectErrorEnvelope(response.body, 'ORDER_ALREADY_SHIPPED');

      const detail = await request(container.app).get(`/api/orders/${orderId}`).expect(200);
      expect(detail.body.order).toMatchObject({
        status: 'SHIPPED',
        cancelledAt: null,
        cancellationReason: null,
      });
    });
  });

  describe('POST /api/orders/:id/ship', () => {
    it('marks a CONFIRMED order SHIPPED and is idempotent', async () => {
      const order = await createOrder([{ productId: ESPRESSO, quantity: 1 }]);
      const orderId = String(order['id']);

      const shipped = await request(container.app)
        .post(`/api/orders/${orderId}/ship`)
        .send({})
        .expect(200);
      const shippedOrder = shipped.body.order as Record<string, unknown>;
      expectOrderView(shippedOrder);
      expect(shippedOrder).toMatchObject({ id: orderId, status: 'SHIPPED' });
      expect(shippedOrder['shippedAt']).toMatch(ISO_UTC);

      const repeated = await request(container.app)
        .post(`/api/orders/${orderId}/ship`)
        .send({})
        .expect(200);
      expect(repeated.body.order.shippedAt).toBe(shippedOrder['shippedAt']);
      expect(repeated.body.order.updatedAt).toBe(shippedOrder['updatedAt']);
    });

    it('accepts an empty body', async () => {
      const order = await createOrder([{ productId: ESPRESSO, quantity: 1 }]);
      await request(container.app)
        .post(`/api/orders/${String(order['id'])}/ship`)
        .expect(200);
    });

    it('returns 404 ORDER_NOT_FOUND for an unknown order', async () => {
      const response = await request(container.app)
        .post('/api/orders/order-nope/ship')
        .send({})
        .expect(404);
      expectErrorEnvelope(response.body, 'ORDER_NOT_FOUND');
    });

    it('returns 409 ORDER_ALREADY_CANCELLED for a cancelled order', async () => {
      const order = await createOrder([{ productId: ESPRESSO, quantity: 1 }]);
      const orderId = String(order['id']);
      await request(container.app)
        .post(`/api/orders/${orderId}/cancel`)
        .send({ reason: 'changed my mind' })
        .expect(200);

      const response = await request(container.app)
        .post(`/api/orders/${orderId}/ship`)
        .send({})
        .expect(409);
      expectErrorEnvelope(response.body, 'ORDER_ALREADY_CANCELLED');

      const detail = await request(container.app).get(`/api/orders/${orderId}`).expect(200);
      expect(detail.body.order.status).toBe('CANCELLED');
    });
  });

  describe('unknown routes and CORS', () => {
    it.each([
      ['GET', '/api/nope'],
      ['GET', '/'],
      ['GET', '/api'],
      ['GET', '/api/products/prod-x/extra'],
      ['POST', '/api/orders/order-1/refund'],
      ['DELETE', '/api/products'],
      ['PUT', '/api/orders'],
    ])('returns 404 NOT_FOUND for %s %s', async (method, path) => {
      const agent = request(container.app);
      const response =
        method === 'GET'
          ? await agent.get(path).expect(404)
          : method === 'POST'
            ? await agent.post(path).send({}).expect(404)
            : method === 'PUT'
              ? await agent.put(path).send({}).expect(404)
              : await agent.delete(path).expect(404);
      expectErrorEnvelope(response.body, 'NOT_FOUND');
    });

    it('answers the browser preflight for the configured origin', async () => {
      const response = await request(container.app)
        .options('/api/orders')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type')
        .expect(204);

      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(String(response.headers['access-control-allow-methods'])).toContain('POST');
    });

    it('sets the CORS origin header on normal responses', async () => {
      const response = await request(container.app)
        .get('/api/products')
        .set('Origin', 'http://localhost:3000')
        .expect(200);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });
  });

  describe('error hygiene', () => {
    it('never leaks SQL, driver details, or stack traces', async () => {
      const cases = [
        await request(container.app).get('/api/products/prod-nope'),
        await request(container.app).get('/api/orders/order-nope'),
        await request(container.app)
          .post('/api/orders')
          .send({ customerId: 'customer-demo', items: [{ productId: 'prod-nope', quantity: 1 }] }),
        await request(container.app).get('/api/unknown'),
      ];

      for (const response of cases) {
        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toMatch(/SELECT|INSERT|UPDATE|relation|pg_|at Object\./i);
        expect(serialized).not.toContain('stack');
      }
    });
  });
});
