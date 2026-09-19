import { Router } from 'express';
import type { ListProducts } from '../../../../application/ports/inbound/list-products.port';
import { handle } from '../async-handler';
import { parsePathId } from '../validate';

export interface CatalogRoutesDeps {
  readonly listProducts: ListProducts;
}

/** GET /api/products and GET /api/products/:id. */
export function createCatalogRouter(deps: CatalogRoutesDeps): Router {
  const router = Router();

  router.get(
    '/products',
    handle(async (_req, res) => {
      const products = await deps.listProducts.execute();
      res.json({ products });
    }),
  );

  router.get(
    '/products/:id',
    handle(async (req, res) => {
      const product = await deps.listProducts.getById(parsePathId(req.params.id, 'productId'));
      res.json({ product });
    }),
  );

  return router;
}
