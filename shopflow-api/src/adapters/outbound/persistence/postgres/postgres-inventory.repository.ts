import type { Inventory } from '../../../../domain/model/product';
import type { InventoryRepository } from '../../../../application/ports/outbound/inventory-repository.port';
import type { SqlExecutor } from '../../../../application/ports/outbound/sql-executor.port';

interface InventoryRow {
  product_id: string;
  available_quantity: number;
  updated_at: Date;
}

function toInventory(row: InventoryRow): Inventory {
  return {
    productId: row.product_id,
    availableQuantity: row.available_quantity,
    updatedAt: row.updated_at,
  };
}

export class PostgresInventoryRepository implements InventoryRepository {
  constructor(private readonly executor: SqlExecutor) {}

  /**
   * Row-level locks acquired in ascending `product_id` order. Concurrent order writes for the
   * same products serialize here, and the fixed order prevents deadlocks between two orders
   * that reference the same products in a different request order.
   */
  async lockByProductIds(productIds: readonly string[]): Promise<readonly Inventory[]> {
    if (productIds.length === 0) {
      return [];
    }
    const result = await this.executor.query<InventoryRow>(
      `SELECT product_id, available_quantity, updated_at
         FROM inventory
        WHERE product_id = ANY($1::text[])
        ORDER BY product_id ASC
        FOR UPDATE`,
      [productIds],
    );
    return result.rows.map(toInventory);
  }

  async decrement(productId: string, quantity: number): Promise<void> {
    await this.executor.query(
      `UPDATE inventory
          SET available_quantity = available_quantity - $2,
              updated_at = now()
        WHERE product_id = $1`,
      [productId, quantity],
    );
  }

  /**
   * Restores stock for one product. The upsert keeps the restore lossless even if the
   * inventory row were missing; the `available_quantity >= 0` CHECK on the row still guards
   * the invariant, and a missing products row raises a foreign-key error instead of silently
   * dropping the restore.
   */
  async increment(productId: string, quantity: number): Promise<void> {
    await this.executor.query(
      `INSERT INTO inventory (product_id, available_quantity, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (product_id)
       DO UPDATE SET available_quantity = inventory.available_quantity + EXCLUDED.available_quantity,
                     updated_at = now()`,
      [productId, quantity],
    );
  }
}
