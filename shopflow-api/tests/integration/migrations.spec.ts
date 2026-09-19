import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresMigrator } from '../../src/adapters/outbound/persistence/postgres/migrator';
import {
  availableQuantity,
  createTestPool,
  dropAllTables,
  MIGRATIONS_DIR,
  migrateTestDatabase,
  requireTestDatabase,
  SCHEMA_TABLES,
  seedBaseline,
  TEST_DATABASE_URL,
} from '../helpers/database';

function createMigrator(pool: Pool): PostgresMigrator {
  return new PostgresMigrator(pool, { migrationsDir: MIGRATIONS_DIR });
}

async function listTables(pool: Pool): Promise<string[]> {
  const result = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  return (result.rows as Array<{ table_name: string }>).map((row) => row.table_name).sort();
}

async function appliedMigrationRows(
  pool: Pool,
): Promise<Array<{ id: string; applied_at: Date }>> {
  const result = await pool.query('SELECT id, applied_at FROM schema_migrations ORDER BY id');
  return result.rows as Array<{ id: string; applied_at: Date }>;
}

describe('migrations (real PostgreSQL 16)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await requireTestDatabase(pool);
  });

  afterAll(async () => {
    await migrateTestDatabase(pool);
    await seedBaseline(pool);
    await pool.end();
  });

  it('applies 001_init verbatim on a fresh database', async () => {
    await dropAllTables(pool);
    const migrator = createMigrator(pool);

    expect(await migrator.isSchemaReady()).toBe(false);
    expect(migrator.loadMigrations().map((migration) => migration.id)).toEqual(['001_init']);

    const result = await migrator.migrate();

    expect(result).toEqual({ applied: ['001_init'], skipped: [] });
    expect(await listTables(pool)).toEqual([...SCHEMA_TABLES].sort());
    expect(await migrator.isSchemaReady()).toBe(true);
  });

  it('is idempotent: running it again applies nothing', async () => {
    const first = await appliedMigrationRows(pool);
    expect(first.map((row) => row.id)).toEqual(['001_init']);

    const result = await createMigrator(pool).migrate();

    expect(result).toEqual({ applied: [], skipped: ['001_init'] });
    const second = await appliedMigrationRows(pool);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe('001_init');
    expect(second[0].applied_at.getTime()).toBe(first[0].applied_at.getTime());
  });

  it('is safe to run concurrently against a fresh database', async () => {
    await dropAllTables(pool);
    const pools = [createTestPool(), createTestPool(), createTestPool()];
    try {
      const results = await Promise.all(pools.map((candidate) => createMigrator(candidate).migrate()));

      const applied = results.flatMap((result) => result.applied);
      const skipped = results.flatMap((result) => result.skipped);
      expect(applied).toEqual(['001_init']);
      expect(skipped).toEqual(['001_init', '001_init']);

      const rows = await appliedMigrationRows(pool);
      expect(rows).toHaveLength(1);
      expect(await listTables(pool)).toEqual([...SCHEMA_TABLES].sort());
    } finally {
      await Promise.all(pools.map((candidate) => candidate.end()));
    }
  });

  it('reports an out-of-date schema when schema_migrations is missing', async () => {
    await dropAllTables(pool);
    expect(await createMigrator(pool).isSchemaReady()).toBe(false);
    await createMigrator(pool).migrate();
    expect(await createMigrator(pool).isSchemaReady()).toBe(true);
  });

  it('uses the configured connection string of shopflow-infra (DATABASE_URL)', () => {
    expect(TEST_DATABASE_URL).toMatch(/^postgres:\/\//);
  });
});

describe('schema constraints (frozen DDL)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await requireTestDatabase(pool);
    await migrateTestDatabase(pool);
    await seedBaseline(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE notification_outbox, order_items, orders CASCADE');
    await seedBaseline(pool);
  });

  afterAll(async () => {
    await pool.query('TRUNCATE TABLE notification_outbox, order_items, orders CASCADE');
    await seedBaseline(pool);
    await pool.end();
  });

  async function expectSqlError(sql: string, params: unknown[], code: string): Promise<void> {
    await expect(pool.query(sql, params)).rejects.toMatchObject({ code });
  }

  it('rejects negative inventory', async () => {
    await expectSqlError(
      'UPDATE inventory SET available_quantity = -1 WHERE product_id = $1',
      ['prod-espresso-machine'],
      '23514',
    );
    expect(await availableQuantity(pool, 'prod-espresso-machine')).toBe(5);
  });

  it('rejects an unknown order status', async () => {
    await expectSqlError(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency)
       VALUES ('bad-status', 'customer-demo', 'PENDING', 100, 'USD')`,
      [],
      '23514',
    );
  });

  it('requires shipped_at exactly when the status is SHIPPED', async () => {
    await expectSqlError(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency)
       VALUES ('shipped-without-date', 'customer-demo', 'SHIPPED', 100, 'USD')`,
      [],
      '23514',
    );
    await expectSqlError(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency, shipped_at)
       VALUES ('confirmed-with-date', 'customer-demo', 'CONFIRMED', 100, 'USD', now())`,
      [],
      '23514',
    );
  });

  it('requires cancelled_at and a 1..200 character reason exactly when the status is CANCELLED', async () => {
    await expectSqlError(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency, cancelled_at)
       VALUES ('cancelled-without-reason', 'customer-demo', 'CANCELLED', 100, 'USD', now())`,
      [],
      '23514',
    );
    await expectSqlError(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency, cancelled_at, cancellation_reason)
       VALUES ('cancelled-empty-reason', 'customer-demo', 'CANCELLED', 100, 'USD', now(), '')`,
      [],
      '23514',
    );
    await expectSqlError(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency, cancelled_at, cancellation_reason)
       VALUES ('cancelled-long-reason', 'customer-demo', 'CANCELLED', 100, 'USD', now(), repeat('x', 201))`,
      [],
      '23514',
    );
    await expectSqlError(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency, cancelled_at, cancellation_reason)
       VALUES ('confirmed-with-cancellation', 'customer-demo', 'CONFIRMED', 100, 'USD', now(), 'why')`,
      [],
      '23514',
    );
  });

  it('rejects non-positive order item quantities and duplicate products per order', async () => {
    await pool.query(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency)
       VALUES ('schema-order', 'customer-demo', 'CONFIRMED', 100, 'USD')`,
    );
    await expectSqlError(
      `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, unit_price_cents, line_total_cents)
       VALUES ('item-zero', 'schema-order', 'prod-espresso-machine', 'Espresso Machine', 0, 100, 0)`,
      [],
      '23514',
    );
    await pool.query(
      `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, unit_price_cents, line_total_cents)
       VALUES ('item-one', 'schema-order', 'prod-espresso-machine', 'Espresso Machine', 1, 100, 100)`,
    );
    await expectSqlError(
      `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, unit_price_cents, line_total_cents)
       VALUES ('item-two', 'schema-order', 'prod-espresso-machine', 'Espresso Machine', 1, 100, 100)`,
      [],
      '23505',
    );
    await pool.query('DELETE FROM order_items WHERE order_id = $1', ['schema-order']);
    await pool.query('DELETE FROM orders WHERE id = $1', ['schema-order']);
  });

  it('enforces product sku uniqueness and the outbox type/status/dedupe_key constraints', async () => {
    await expectSqlError(
      `INSERT INTO products (id, sku, name, price_cents, currency)
       VALUES ('dup-sku', 'SF-ESP-001', 'Duplicate', 100, 'USD')`,
      [],
      '23505',
    );
    await pool.query(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency)
       VALUES ('outbox-constraint-order', 'customer-demo', 'CONFIRMED', 100, 'USD')`,
    );
    await expectSqlError(
      `INSERT INTO notification_outbox (id, dedupe_key, type, order_id, payload)
       VALUES ('outbox-bad-type', 'dedupe-bad-type', 'ORDER_REFUNDED', 'outbox-constraint-order', '{}'::jsonb)`,
      [],
      '23514',
    );
    await expectSqlError(
      `INSERT INTO notification_outbox (id, dedupe_key, type, order_id, payload)
       VALUES ('outbox-bad-status', 'dedupe-bad-status', 'ORDER_CONFIRMED', 'missing-order', '{}'::jsonb)`,
      [],
      '23503',
    );
    await expectSqlError(
      `INSERT INTO notification_outbox (id, dedupe_key, type, order_id, payload, status)
       VALUES ('outbox-bad-status', 'dedupe-bad-status-2', 'ORDER_CONFIRMED', 'outbox-constraint-order', '{}'::jsonb, 'QUEUED')`,
      [],
      '23514',
    );
  });

  it('enforces dedupe_key uniqueness for a real order', async () => {
    await pool.query(
      `INSERT INTO orders (id, customer_id, status, total_cents, currency)
       VALUES ('dedupe-order', 'customer-demo', 'CONFIRMED', 100, 'USD')`,
    );
    const insert = `INSERT INTO notification_outbox (id, dedupe_key, type, order_id, payload)
                    VALUES ($1, $2, 'ORDER_CONFIRMED', 'dedupe-order', '{}'::jsonb)`;
    await pool.query(insert, ['outbox-first', 'order:dedupe-order:confirmed']);
    await expectSqlError(insert, ['outbox-second', 'order:dedupe-order:confirmed'], '23505');
    await pool.query('DELETE FROM notification_outbox WHERE order_id = $1', ['dedupe-order']);
    await pool.query('DELETE FROM orders WHERE id = $1', ['dedupe-order']);
  });

});
