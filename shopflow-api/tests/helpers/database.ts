import type { Pool } from 'pg';
import { Pool as PgPool } from 'pg';
import path from 'node:path';
import { PostgresMigrator } from '../../src/adapters/outbound/persistence/postgres/migrator';
import { PostgresSeeder } from '../../src/adapters/outbound/persistence/postgres/postgres-seeder';

/** Test-only PostgreSQL started by docker-compose.test.yml. */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://shopflow:shopflow@localhost:55432/shopflow_test';

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export const TRANSACTIONAL_TABLES = ['notification_outbox', 'order_items', 'orders'] as const;
export const SCHEMA_TABLES = [
  'schema_migrations',
  'products',
  'inventory',
  'orders',
  'order_items',
  'notification_outbox',
] as const;

export function createTestPool(): Pool {
  return new PgPool({
    connectionString: TEST_DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
}

/** Fails loudly (never silently skips) when the test database is not reachable. */
export async function requireTestDatabase(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(
      `Test PostgreSQL is not reachable at ${TEST_DATABASE_URL}. ` +
        'Start it with: docker compose -f docker-compose.test.yml up -d --wait. ' +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function migrateTestDatabase(pool: Pool): Promise<void> {
  await new PostgresMigrator(pool, { migrationsDir: MIGRATIONS_DIR }).migrate();
}

export async function ensureSchema(pool: Pool): Promise<void> {
  await requireTestDatabase(pool);
  const migrator = new PostgresMigrator(pool, { migrationsDir: MIGRATIONS_DIR });
  if (!(await migrator.isSchemaReady())) {
    await migrator.migrate();
  }
}

export async function seedBaseline(pool: Pool): Promise<void> {
  await new PostgresSeeder(pool).run();
}

export async function dropAllTables(pool: Pool): Promise<void> {
  await pool.query(
    `DROP TABLE IF EXISTS ${[...TRANSACTIONAL_TABLES, 'inventory', 'products', 'schema_migrations'].join(', ')} CASCADE`,
  );
}

/**
 * Empties orders/order items/outbox and restores the documented inventory baseline, so each
 * test starts from the exact seed dataset.
 */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${TRANSACTIONAL_TABLES.join(', ')} CASCADE`);
  await seedBaseline(pool);
}

export async function countRows(pool: Pool, table: string): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
  return (result.rows[0] as { count: number }).count;
}

export async function availableQuantity(pool: Pool, productId: string): Promise<number> {
  const result = await pool.query('SELECT available_quantity FROM inventory WHERE product_id = $1', [
    productId,
  ]);
  const row = result.rows[0] as { available_quantity: number } | undefined;
  if (row === undefined) {
    throw new Error(`no inventory row for ${productId}`);
  }
  return row.available_quantity;
}
