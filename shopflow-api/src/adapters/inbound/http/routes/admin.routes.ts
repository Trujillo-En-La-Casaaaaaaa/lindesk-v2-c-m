import { Router } from 'express';
import type { ShipOrder } from '../../../../application/ports/inbound/ship-order.port';
import { handle } from '../async-handler';
import { parsePathId } from '../validate';

export interface AdminRoutesDeps {
  readonly shipOrder: ShipOrder;
}

/** Administrative action: POST /api/orders/:id/ship. The body is empty or `{}`. */
export function createAdminRouter(deps: AdminRoutesDeps): Router {
  const router = Router();

  router.post(
    '/orders/:id/ship',
    handle(async (req, res) => {
      const order = await deps.shipOrder.execute(parsePathId(req.params.id, 'orderId'));
      res.status(200).json({ order });
    }),
  );

  return router;
}
