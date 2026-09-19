import { InsufficientInventoryError } from '../errors';

/** A sellable product. Framework-free. */
export interface Product {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly createdAt: Date;
}

/** The available stock of one product. */
export interface Inventory {
  readonly productId: string;
  readonly availableQuantity: number;
  readonly updatedAt: Date;
}

/** A product together with its current availability. */
export interface ProductWithAvailability {
  readonly product: Product;
  readonly availableQuantity: number;
}

/** Wire shape frozen by handoff/API_CONTRACT.md (Product view). */
export interface ProductView {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly availableQuantity: number;
}

export function toProductView(input: ProductWithAvailability): ProductView {
  return {
    id: input.product.id,
    sku: input.product.sku,
    name: input.product.name,
    description: input.product.description,
    priceCents: input.product.priceCents,
    currency: input.product.currency,
    availableQuantity: input.availableQuantity,
  };
}

/**
 * Inventory invariant: an order line can only be accepted when the currently available
 * quantity covers it. Removing stock is only ever done through this guard.
 */
export function assertInventoryAvailable(
  productId: string,
  requested: number,
  available: number,
): void {
  if (available < requested) {
    throw new InsufficientInventoryError(productId, requested, available);
  }
}
