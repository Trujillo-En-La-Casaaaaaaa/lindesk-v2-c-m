import type { Product, ProductWithAvailability } from '../../../domain/model/product';

/** Read access to the product catalog. Always executed inside a unit of work. */
export interface ProductRepository {
  findById(id: string): Promise<Product | null>;
  /** Products that exist for the given ids; unknown ids are simply absent from the result. */
  findByIds(ids: readonly string[]): Promise<readonly Product[]>;
  /** Catalog ordered by name ascending, then id ascending. */
  listWithAvailability(): Promise<readonly ProductWithAvailability[]>;
  findWithAvailability(id: string): Promise<ProductWithAvailability | null>;
}
