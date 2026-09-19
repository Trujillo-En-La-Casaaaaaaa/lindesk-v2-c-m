import { ProductNotFoundError } from '../../domain/errors';
import type { ProductView } from '../../domain/model/product';
import { toProductView } from '../../domain/model/product';
import type { ListProducts } from '../ports/inbound/list-products.port';
import type { UnitOfWork } from '../ports/outbound/unit-of-work.port';
import { requireNonEmptyId } from './identifiers';

export interface ListProductsDeps {
  readonly unitOfWork: UnitOfWork;
}

/** GET /api/products and GET /api/products/:id — catalog plus available inventory quantity. */
export class ListProductsUseCase implements ListProducts {
  constructor(private readonly deps: ListProductsDeps) {}

  async execute(): Promise<readonly ProductView[]> {
    return this.deps.unitOfWork.run(async (tx) => {
      const products = await tx.products.listWithAvailability();
      return products.map(toProductView);
    });
  }

  async getById(productId: string): Promise<ProductView> {
    const id = requireNonEmptyId(productId, 'productId');
    return this.deps.unitOfWork.run(async (tx) => {
      const product = await tx.products.findWithAvailability(id);
      if (product === null) {
        throw new ProductNotFoundError(id);
      }
      return toProductView(product);
    });
  }
}
