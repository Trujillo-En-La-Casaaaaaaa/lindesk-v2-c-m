import { OrderAlreadyCancelledError, OrderNotFoundError } from '../../domain/errors';
import type { Order, OrderView } from '../../domain/model/order';
import { planShipment, toOrderView } from '../../domain/model/order';
import type { ShipOrder } from '../ports/inbound/ship-order.port';
import type { Clock } from '../ports/outbound/clock.port';
import type { UnitOfWork } from '../ports/outbound/unit-of-work.port';
import { requireNonEmptyId } from './identifiers';

export interface ShipOrderDeps {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * POST /api/orders/:id/ship — administrative action, one transaction:
 * lock the order row → state machine → (CONFIRMED only) set status SHIPPED and shipped_at.
 * Repeating the action on an already shipped order returns the persisted order unchanged.
 */
export class ShipOrderUseCase implements ShipOrder {
  constructor(private readonly deps: ShipOrderDeps) {}

  async execute(orderId: string): Promise<OrderView> {
    const id = requireNonEmptyId(orderId, 'orderId');

    return this.deps.unitOfWork.run(async (tx) => {
      const order = await tx.orders.findByIdForUpdate(id);
      if (order === null) {
        throw new OrderNotFoundError(id);
      }

      const decision = planShipment(order);
      if (decision.type === 'REJECT_CANCELLED') {
        throw new OrderAlreadyCancelledError(id);
      }

      const items = await tx.orders.listItems(id);
      if (decision.type === 'ALREADY_SHIPPED') {
        return toOrderView(order, items);
      }

      const shippedAt = this.deps.clock.now();
      await tx.orders.markShipped({ orderId: id, shippedAt, updatedAt: shippedAt });
      const shipped: Order = { ...order, status: 'SHIPPED', shippedAt, updatedAt: shippedAt };
      return toOrderView(shipped, items);
    });
  }
}
