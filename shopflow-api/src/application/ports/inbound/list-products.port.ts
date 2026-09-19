import type { ProductView } from '../../../domain/model/product';

export interface ListProducts {
  /** Catalog ordered by name ascending, then id ascending. */
  execute(): Promise<readonly ProductView[]>;
  /** Single product with its availability, or PRODUCT_NOT_FOUND. */
  getById(productId: string): Promise<ProductView>;
}
