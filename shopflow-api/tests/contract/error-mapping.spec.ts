import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHttpApp, type HttpServerUseCases } from '../../src/adapters/inbound/http/server';
import { silentLogger } from '../helpers/fakes';

const CORS_ORIGIN = 'http://localhost:3000';

/** Every use case fails with an unexpected (non-domain) error, like a broken database. */
function failingUseCases(): HttpServerUseCases {
  const boom = async (): Promise<never> => {
    throw new Error('relation "orders" does not exist');
  };
  return {
    createOrder: { execute: boom },
    getOrder: { execute: boom },
    listOrders: { execute: boom },
    listProducts: { execute: boom, getById: boom },
    cancelOrder: { execute: boom },
    shipOrder: { execute: boom },
  };
}

describe('error mapping', () => {
  it('maps unexpected failures to 500 INTERNAL_ERROR without leaking detail', async () => {
    const app = createHttpApp({
      corsOrigin: CORS_ORIGIN,
      logger: silentLogger,
      databaseProbe: { probe: async () => true },
      useCases: failingUseCases(),
    });

    const response = await request(app).get('/api/products').expect(500);

    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} },
    });
    expect(JSON.stringify(response.body)).not.toContain('relation');
    expect(JSON.stringify(response.body)).not.toContain('does not exist');
  });

  it('maps a failing database probe to 503 degraded', async () => {
    const app = createHttpApp({
      corsOrigin: CORS_ORIGIN,
      logger: silentLogger,
      databaseProbe: { probe: async () => false },
      useCases: failingUseCases(),
    });

    const response = await request(app).get('/health').expect(503);
    expect(response.body).toEqual({ status: 'degraded', database: 'down' });
  });

  it('maps a thrown non-Error value to 500 INTERNAL_ERROR', async () => {
    const app = createHttpApp({
      corsOrigin: CORS_ORIGIN,
      logger: silentLogger,
      databaseProbe: { probe: async () => true },
      useCases: {
        ...failingUseCases(),
        listProducts: {
          execute: async () => {
            throw 'plain string failure';
          },
          getById: async () => {
            throw 'plain string failure';
          },
        },
      },
    });

    const response = await request(app).get('/api/products').expect(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} },
    });
  });

  it('rejects a request body larger than the configured limit instead of buffering it', async () => {
    const app = createHttpApp({
      corsOrigin: CORS_ORIGIN,
      logger: silentLogger,
      databaseProbe: { probe: async () => true },
      useCases: failingUseCases(),
    });

    const response = await request(app)
      .post('/api/orders')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ customerId: 'customer-demo', items: [], padding: 'x'.repeat(400_000) }))
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
