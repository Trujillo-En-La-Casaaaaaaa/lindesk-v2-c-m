import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresSeeder } from '../../src/adapters/outbound/persistence/postgres/postgres-seeder';
import { SEED_CREATED_AT, SEED_PRODUCTS } from '../../src/adapters/outbound/persistence/postgres/seed-data';
import {
  availableQuantity,
  countRows,
  createTestPool,
  dropAllTables,
  ensureSchema,
  resetDatabase,
  seedBaseline,
} from '../helpers/database';
import { runNpmScript, runNpmScriptPair } from '../helpers/cli';

/** npm prints its own banner on stdout; the seed summary line is the `seed:` one. */
function seedSummaryLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('seed:'));
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  created_at: Date;
}

interface InventoryRow {
  product_id: string;
  available_quantity: number;
  updated_at: Date;
}

async function productRows(pool: Pool): Promise<ProductRow[]> {
  const result = await pool.query('SELECT * FROM products ORDER BY id');
  return result.rows as ProductRow[];
}

async function inventoryRows(pool: Pool): Promise<InventoryRow[]> {
  const result = await pool.query('SELECT * FROM inventory ORDER BY product_id');
  return result.rows as InventoryRow[];
}

describe('deterministic seed data', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
  });

  afterAll(async () => {
    await pool.query('TRUNCATE TABLE notification_outbox, order_items, orders CASCADE');
    await seedBaseline(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it('loads exactly the documented dataset with fixed primary keys and timestamps', async () => {
    const result = await new PostgresSeeder(pool).run();
    expect(result).toEqual({ products: 4, inventory: 4 });

    const products = await productRows(pool);
    expect(products).toHaveLength(4);
    for (const product of products) {
      const expected = SEED_PRODUCTS.find((candidate) => candidate.id === product.id);
      expect(expected).toBeDefined();
      expect(product).toMatchObject({
        id: expected?.id,
        sku: expected?.sku,
        name: expected?.name,
        description: expected?.description,
        price_cents: expected?.priceCents,
        currency: expected?.currency,
      });
      expect(product.created_at.toISOString()).toBe(SEED_CREATED_AT);
    }

    const inventory = await inventoryRows(pool);
    expect(inventory.map((row) => [row.product_id, row.available_quantity])).toEqual([
      ['prod-burr-grinder', 10],
      ['prod-coffee-beans-1kg', 40],
      ['prod-espresso-machine', 5],
      ['prod-milk-pitcher', 25],
    ]);
    for (const row of inventory) {
      expect(row.updated_at.toISOString()).toBe(SEED_CREATED_AT);
    }

    expect(await countRows(pool, 'orders')).toBe(0);
    expect(await countRows(pool, 'notification_outbox')).toBe(0);
  });

  it('is idempotent: a second run produces the exact same state', async () => {
    const seeder = new PostgresSeeder(pool);
    await seeder.run();
    const productsBefore = await productRows(pool);
    const inventoryBefore = await inventoryRows(pool);

    await seeder.run();

    expect(await productRows(pool)).toEqual(productsBefore);
    expect(await inventoryRows(pool)).toEqual(inventoryBefore);
    expect(await countRows(pool, 'products')).toBe(4);
    expect(await countRows(pool, 'inventory')).toBe(4);
  });

  it('resets inventory to the documented baseline after manual testing', async () => {
    await pool.query('UPDATE inventory SET available_quantity = 0, updated_at = now()');
    await pool.query('UPDATE products SET price_cents = 1');

    await new PostgresSeeder(pool).run();

    expect(await availableQuantity(pool, 'prod-espresso-machine')).toBe(5);
    expect(await availableQuantity(pool, 'prod-burr-grinder')).toBe(10);
    expect(await availableQuantity(pool, 'prod-milk-pitcher')).toBe(25);
    expect(await availableQuantity(pool, 'prod-coffee-beans-1kg')).toBe(40);
    const products = await productRows(pool);
    for (const product of products) {
      const expected = SEED_PRODUCTS.find((candidate) => candidate.id === product.id);
      expect(product.price_cents).toBe(expected?.priceCents);
    }
  });

  it('never creates orders or notification intents', async () => {
    await new PostgresSeeder(pool).run();
    expect(await countRows(pool, 'orders')).toBe(0);
    expect(await countRows(pool, 'order_items')).toBe(0);
    expect(await countRows(pool, 'notification_outbox')).toBe(0);
  });
});

describe('CLI: npm run migrate / npm run seed', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
  });

  afterAll(async () => {
    await ensureSchema(pool);
    await seedBaseline(pool);
    await pool.end();
  });

  it('runs `npm run migrate` twice: the first applies 001_init, the second applies nothing', async () => {
    await dropAllTables(pool);

    const first = await runNpmScript('migrate');
    expect(first.status).toBe(0);
    const firstLog = first.logs.find((entry) => entry['message'] === 'migrate: done');
    expect(firstLog).toBeDefined();
    expect(firstLog?.['applied']).toEqual(['001_init']);
    expect(firstLog?.['skipped']).toEqual([]);

    const second = await runNpmScript('migrate');
    expect(second.status).toBe(0);
    const secondLog = second.logs.find((entry) => entry['message'] === 'migrate: done');
    expect(secondLog).toBeDefined();
    expect(secondLog?.['applied']).toEqual([]);
    expect(secondLog?.['skipped']).toEqual(['001_init']);

    const rows = await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
    expect((rows.rows[0] as { count: number }).count).toBe(1);
  });

  it('runs two `npm run migrate` processes concurrently against a fresh database', async () => {
    await dropAllTables(pool);

    const results = await runNpmScriptPair('migrate', 'migrate');
    for (const result of results) {
      expect(result.status).toBe(0);
    }
    const appliedTotal = results
      .flatMap((result) => result.logs.filter((entry) => entry['message'] === 'migrate: done'))
      .reduce<number>((total, entry) => total + (entry['applied'] as unknown[]).length, 0);
    expect(appliedTotal).toBe(1);

    const rows = await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
    expect((rows.rows[0] as { count: number }).count).toBe(1);
  });

  it('runs `npm run seed` twice and prints the documented summary line both times', async () => {
    const first = await runNpmScript('seed');
    expect(first.status).toBe(0);
    expect(seedSummaryLines(first.stdout)).toEqual(['seed: products=4 inventory=4']);

    const productsAfterFirst = await productRows(pool);
    const inventoryAfterFirst = await inventoryRows(pool);

    const second = await runNpmScript('seed');
    expect(second.status).toBe(0);
    expect(seedSummaryLines(second.stdout)).toEqual(['seed: products=4 inventory=4']);

    expect(await productRows(pool)).toEqual(productsAfterFirst);
    expect(await inventoryRows(pool)).toEqual(inventoryAfterFirst);
    expect(await countRows(pool, 'products')).toBe(4);
    expect(await countRows(pool, 'inventory')).toBe(4);
    expect(await countRows(pool, 'orders')).toBe(0);
  });

  it('fails with exit code 1 when DATABASE_URL is missing', async () => {
    const result = await runNpmScript('migrate', { env: { DATABASE_URL: '' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL is required');
  });
});
