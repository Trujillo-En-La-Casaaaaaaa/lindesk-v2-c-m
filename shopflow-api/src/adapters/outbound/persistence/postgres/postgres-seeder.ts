import type { Pool } from 'pg';
import { SEED_CREATED_AT, SEED_PRODUCTS } from './seed-data';

export interface SeedResult {
  readonly products: number;
  readonly inventory: number;
}

const UPSERT_PRODUCT_SQL = `
  INSERT INTO products (id, sku, name, description, price_cents, currency, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (id) DO UPDATE
    SET sku = EXCLUDED.sku,
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        price_cents = EXCLUDED.price_cents,
        currency = EXCLUDED.currency,
        created_at = EXCLUDED.created_at
`;

const UPSERT_INVENTORY_SQL = `
  INSERT INTO inventory (product_id, available_quantity, updated_at)
  VALUES ($1, $2, $3)
  ON CONFLICT (product_id) DO UPDATE
    SET available_quantity = EXCLUDED.available_quantity,
        updated_at = EXCLUDED.updated_at
`;

/**
 * Loads the deterministic dataset with fixed primary keys, so running it twice converges to
 * the same state. Inventory availability is reset to the documented baseline, which also makes
 * re-seeding after manual testing a known starting point. Orders and notification_outbox are
 * never touched.
 */
export class PostgresSeeder {
  constructor(private readonly pool: Pool) {}

  async run(): Promise<SeedResult> {
    const createdAt = new Date(SEED_CREATED_AT);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const product of SEED_PRODUCTS) {
        await client.query(UPSERT_PRODUCT_SQL, [
          product.id,
          product.sku,
          product.name,
          product.description,
          product.priceCents,
          product.currency,
          createdAt,
        ]);
      }
      for (const product of SEED_PRODUCTS) {
        await client.query(UPSERT_INVENTORY_SQL, [product.id, product.availableQuantity, createdAt]);
      }
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is released below; the original error is what matters.
      }
      throw error;
    } finally {
      client.release();
    }

    return { products: SEED_PRODUCTS.length, inventory: SEED_PRODUCTS.length };
  }
}
