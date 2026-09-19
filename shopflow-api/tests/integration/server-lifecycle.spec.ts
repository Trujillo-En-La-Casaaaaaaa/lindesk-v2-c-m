import { spawn, type ChildProcess } from 'node:child_process';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, ConfigurationError } from '../../src/composition/config';
import { createContainer, type Container } from '../../src/composition/container';
import { startServer } from '../../src/main/server';
import { createTestContainer, testConfig } from '../helpers/app';
import { countRows, createTestPool, ensureSchema, resetDatabase } from '../helpers/database';
import { startNotificationEmulator, type NotificationEmulator } from '../helpers/notification-emulator';
import { getFreePort, waitFor, waitForHttpOk } from '../helpers/process';
import { runProcess, requireBuiltEntrypoint } from '../helpers/cli';

const ESPRESSO = 'prod-espresso-machine';
const CAN_DELIVER_SIGTERM = process.platform !== 'win32';

interface ChildServer {
  readonly child: ChildProcess;
  readonly port: number;
  readonly exit: Promise<number | null>;
}

async function spawnServer(port: number, notificationProviderUrl: string): Promise<ChildServer> {
  const entrypoint = requireBuiltEntrypoint('start');
  const child = spawn(
    process.execPath,
    [entrypoint],
    {
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: testConfig().databaseUrl,
        NOTIFICATION_PROVIDER_URL: notificationProviderUrl,
        CORS_ORIGIN: 'http://localhost:3000',
        LOG_LEVEL: 'error',
        OUTBOX_POLL_INTERVAL_MS: '25',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exit = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
  });
  await waitForHttpOk(`http://127.0.0.1:${port}/health`, { timeoutMs: 20_000 });
  return { child, port, exit };
}

describe('configuration', () => {
  it('parses the documented variables and defaults', () => {
    const config = loadConfig({
      env: {
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        NOTIFICATION_PROVIDER_URL: 'http://localhost:8081/',
      },
    });
    expect(config).toEqual({
      port: 8080,
      databaseUrl: 'postgres://user:pass@localhost:5432/db',
      notificationProviderUrl: 'http://localhost:8081/',
      corsOrigin: 'http://localhost:3000',
      outboxPollIntervalMs: 250,
      outboxMaxAttempts: 10,
      logLevel: 'info',
      migrationsDir: undefined,
    });
  });

  it('rejects a missing or malformed DATABASE_URL', () => {
    expect(() => loadConfig({ env: {} })).toThrowError(ConfigurationError);
    expect(() =>
      loadConfig({ env: { DATABASE_URL: 'mysql://nope', NOTIFICATION_PROVIDER_URL: 'http://x' } }),
    ).toThrowError(/postgres/);
  });

  it('requires the notification provider for the API process only', () => {
    const env = { DATABASE_URL: 'postgres://user:pass@localhost:5432/db' };
    expect(() => loadConfig({ env })).toThrowError(/NOTIFICATION_PROVIDER_URL/);
    expect(loadConfig({ env, requireNotificationProvider: false }).notificationProviderUrl).toBe('');
  });

  it('rejects invalid tuning values', () => {
    const base = {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      NOTIFICATION_PROVIDER_URL: 'http://localhost:8081',
    };
    expect(() => loadConfig({ env: { ...base, PORT: 'abc' } })).toThrowError(/PORT/);
    expect(() => loadConfig({ env: { ...base, PORT: '0' } })).toThrowError(/PORT/);
    expect(() => loadConfig({ env: { ...base, OUTBOX_MAX_ATTEMPTS: '0' } })).toThrowError(
      /OUTBOX_MAX_ATTEMPTS/,
    );
    expect(() => loadConfig({ env: { ...base, LOG_LEVEL: 'loud' } })).toThrowError(/LOG_LEVEL/);
  });
});

describe('service lifecycle against real PostgreSQL 16', () => {
  let pool: Pool;
  let container: Container;
  let emulator: NotificationEmulator;

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
    emulator = await startNotificationEmulator();
  });

  afterAll(async () => {
    await emulator.close();
    await pool.end();
  });

  it('starts, serves /health 200 with a live database, dispatches, and shuts down cleanly', async () => {
    await resetDatabase(pool);
    container = createTestContainer({
      port: 0,
      notificationProviderUrl: emulator.baseUrl,
      outboxPollIntervalMs: 25,
    });

    const order = await container.useCases.createOrder.execute({
      customerId: 'customer-demo',
      items: [{ productId: ESPRESSO, quantity: 1 }],
    });

    const running = await startServer(container);
    expect(running.port).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', database: 'up' });
    expect(health.headers.get('content-type')).toContain('application/json');

    const products = await fetch(`http://127.0.0.1:${running.port}/api/products`);
    expect(products.status).toBe(200);
    const body = (await products.json()) as { products: unknown[] };
    expect(body.products).toHaveLength(4);

    // The dispatcher runs with the server and drains the pending intent.
    await waitFor(async () => {
      const state = await pool.query(
        'SELECT status FROM notification_outbox WHERE order_id = $1',
        [order.id],
      );
      return (state.rows[0] as { status: string }).status === 'SENT';
    }, 5_000);
    expect(emulator.logicalCount()).toBe(1);

    await running.stop('SIGTERM');

    // HTTP server is closed.
    await expect(fetch(`http://127.0.0.1:${running.port}/health`)).rejects.toThrow();
    // Connection pool is closed.
    await expect(container.unitOfWork.run(async () => 1)).rejects.toThrow(/pool/i);
    // Stopping twice is safe.
    await running.stop('SIGTERM');
  }, 30_000);

  it('applies pending migrations at startup when the schema is missing', async () => {
    await pool.query('DROP TABLE IF EXISTS notification_outbox, order_items, orders, inventory, products, schema_migrations CASCADE');
    container = createTestContainer({ port: 0, notificationProviderUrl: emulator.baseUrl });

    const running = await startServer(container);
    try {
      const health = await fetch(`http://127.0.0.1:${running.port}/health`);
      expect(health.status).toBe(200);
      const tables = await pool.query(
        `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      expect((tables.rows[0] as { count: number }).count).toBe(6);
    } finally {
      await running.stop('test');
    }
    await resetDatabase(pool);
  }, 30_000);

  it.skipIf(!CAN_DELIVER_SIGTERM)(
    'the production entrypoint exits 0 when the OS delivers SIGTERM',
    async () => {
      const port = await getFreePort();
      const server = await spawnServer(port, emulator.baseUrl);

      server.child.kill('SIGTERM');
      const exitCode = await server.exit;

      expect(exitCode).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    },
    30_000,
  );

  it('the production entrypoint boots with real environment variables and serves /health', async () => {
    const port = await getFreePort();
    const server = await spawnServer(port, emulator.baseUrl);
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok', database: 'up' });
      expect(server.child.exitCode).toBeNull();
    } finally {
      server.child.kill();
      await server.exit;
    }
  }, 30_000);

  it('migrate/seed CLIs run without a notification provider configured', async () => {
    const result = await runProcess(process.execPath, [requireBuiltEntrypoint('seed')], {
      ...process.env,
      DATABASE_URL: testConfig().databaseUrl,
      LOG_LEVEL: 'error',
      NOTIFICATION_PROVIDER_URL: '',
    }, { timeoutMs: 60_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('seed: products=4 inventory=4');
    expect(await countRows(pool, 'orders')).toBe(0);
  }, 60_000);
});

describe('factory wiring', () => {
  it('creates a container whose app is usable without listening', async () => {
    const container = createContainer(testConfig(), {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    try {
      expect(typeof container.app).toBe('function');
      expect(typeof container.useCases.createOrder.execute).toBe('function');
      await expect(container.unitOfWork.probe()).resolves.toBe(true);
    } finally {
      await container.close();
    }
  });
});
