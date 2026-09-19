import type { Inventory } from '../../../domain/model/product';

/**
 * Read/write access to inventory. Mutations happen only inside the order transactions
 * described by the handoff (create decrements, cancel restores).
 */
export interface InventoryRepository {
  /**
   * Locks the inventory rows for the given product ids in ascending `product_id` order
   * (`SELECT ... FOR UPDATE ORDER BY product_id`) to serialize concurrent order writes and
   * avoid deadlocks. Rows that do not exist are absent from the result.
   */
  lockByProductIds(productIds: readonly string[]): Promise<readonly Inventory[]>;
  /** `available_quantity = available_quantity - quantity` for one product. */
  decrement(productId: string, quantity: number): Promise<void>;
  /** `available_quantity = available_quantity + quantity` for one product. */
  increment(productId: string, quantity: number): Promise<void>;
}
