import { Router } from 'express';
import type { CancelOrder } from '../../../../application/ports/inbound/cancel-order.port';
import type { CreateOrder, CreateOrderInput } from '../../../../application/ports/inbound/create-order.port';
import type { GetOrder } from '../../../../application/ports/inbound/get-order.port';
import type { ListOrders } from '../../../../application/ports/inbound/list-orders.port';
import { handle } from '../async-handler';
import { parseCancellationReason, parseOrderListLimit, parsePathId } from '../validate';

export interface OrderRoutesDeps {
  readonly createOrder: CreateOrder;
  readonly getOrder: GetOrder;
  readonly listOrders: ListOrders;
  readonly cancelOrder: CancelOrder;
}

/**
 * Customer-facing order endpoints. The request body is treated as untrusted input: the shapes
 * here are only asserted so the use cases can be called with typed values, and the use cases
 * re-validate every rule before any write happens.
 */
export function createOrderRouter(deps: OrderRoutesDeps): Router {
  const router = Router();

  router.post(
    '/orders',
    handle(async (req, res) => {
      const body = req.body as CreateOrderInput;
      const order = await deps.createOrder.execute(body);
      res.status(201).json({ order });
    }),
  );

  router.get(
    '/orders',
    handle(async (req, res) => {
      const orders = await deps.listOrders.execute(parseOrderListLimit(req.query.limit));
      res.json({ orders });
    }),
  );

  router.get(
    '/orders/:id',
    handle(async (req, res) => {
      const order = await deps.getOrder.execute(parsePathId(req.params.id, 'orderId'));
      res.json({ order });
    }),
  );

  router.post(
    '/orders/:id/cancel',
    handle(async (req, res) => {
      const order = await deps.cancelOrder.execute(
        parsePathId(req.params.id, 'orderId'),
        parseCancellationReason(req.body),
      );
      res.status(200).json({ order });
    }),
  );

  return router;
}
