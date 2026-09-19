import type { Product, ProductWithAvailability } from '../../../../domain/model/product';
import type { ProductRepository } from '../../../../application/ports/outbound/product-repository.port';
import type { SqlExecutor } from '../../../../application/ports/outbound/sql-executor.port';

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  created_at: Date;
}

interface ProductWithAvailabilityRow extends ProductRow {
  available_quantity: number | null;
}

const CATALOG_SELECT = `
  SELECT p.id,
         p.sku,
         p.name,
         p.description,
         p.price_cents,
         p.currency,
         p.created_at,
         i.available_quantity
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id
`;

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    currency: row.currency,
    createdAt: row.created_at,
  };
}

function toProductWithAvailability(row: ProductWithAvailabilityRow): ProductWithAvailability {
  return {
    product: toProduct(row),
    // A product without an inventory row has no sellable stock.
    availableQuantity: row.available_quantity ?? 0,
  };
}

export class PostgresProductRepository implements ProductRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async findById(id: string): Promise<Product | null> {
    const result = await this.executor.query<ProductRow>(
      `SELECT id, sku, name, description, price_cents, currency, created_at
         FROM products WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toProduct(row);
  }

  async findByIds(ids: readonly string[]): Promise<readonly Product[]> {
    if (ids.length === 0) {
      return [];
    }
    const result = await this.executor.query<ProductRow>(
      `SELECT id, sku, name, description, price_cents, currency, created_at
         FROM products WHERE id = ANY($1::text[]) ORDER BY id ASC`,
      [ids],
    );
    return result.rows.map(toProduct);
  }

  async listWithAvailability(): Promise<readonly ProductWithAvailability[]> {
    const result = await this.executor.query<ProductWithAvailabilityRow>(
      `${CATALOG_SELECT} ORDER BY p.name ASC, p.id ASC`,
    );
    return result.rows.map(toProductWithAvailability);
  }

  async findWithAvailability(id: string): Promise<ProductWithAvailability | null> {
    const result = await this.executor.query<ProductWithAvailabilityRow>(
      `${CATALOG_SELECT} WHERE p.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toProductWithAvailability(row);
  }
}
