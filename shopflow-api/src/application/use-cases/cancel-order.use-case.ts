import { OrderAlreadyShippedError, OrderNotFoundError } from '../../domain/errors';
import { planCancellation, normalizeCancellationReason } from '../../domain/model/cancellation';
import type { Order, OrderView } from '../../domain/model/order';
import { toOrderView } from '../../domain/model/order';
import type { CancelOrder } from '../ports/inbound/cancel-order.port';
import type { Clock } from '../ports/outbound/clock.port';
import type { IdGenerator } from '../ports/outbound/id-generator.port';
import type { UnitOfWork } from '../ports/outbound/unit-of-work.port';
import { requireNonEmptyId } from './identifiers';
import { buildOrderCancelledNotification, orderCancelledDedupeKey } from './notification-intent';

export interface CancelOrderDeps {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * POST /api/orders/:id/cancel — one transaction:
 * lock the order row → state machine → (CONFIRMED only) validate the reason, set
 * status/cancelledAt/cancellationReason, restore inventory once, record exactly one
 * ORDER_CANCELLED intent → commit.
 *
 * SHIPPED orders are rejected and already-cancelled orders short-circuit to the stored result,
 * which is what makes concurrent and repeated cancellations restore inventory exactly once.
 */
export class CancelOrderUseCase implements CancelOrder {
  constructor(private readonly deps: CancelOrderDeps) {}

  async execute(orderId: string, reason: unknown): Promise<OrderView> {
    const id = requireNonEmptyId(orderId, 'orderId');

    return this.deps.unitOfWork.run(async (tx) => {
      const order = await tx.orders.findByIdForUpdate(id);
      if (order === null) {
        throw new OrderNotFoundError(id);
      }

      const decision = planCancellation(order);
      if (decision.type === 'REJECT_SHIPPED') {
        throw new OrderAlreadyShippedError(id);
      }

      const items = await tx.orders.listItems(id);
      if (decision.type === 'ALREADY_CANCELLED') {
        // Repeated cancellation is a no-op: no inventory restore, no notification.
        return toOrderView(order, items);
      }

      const normalizedReason = normalizeCancellationReason(reason);
      const cancelledAt = this.deps.clock.now();
      await tx.orders.markCancelled({
        orderId: id,
        cancelledAt,
        reason: normalizedReason,
        updatedAt: cancelledAt,
      });
      for (const item of items) {
        await tx.inventory.increment(item.productId, item.quantity);
      }

      const cancelled: Order = {
        ...order,
        status: 'CANCELLED',
        cancelledAt,
        cancellationReason: normalizedReason,
        updatedAt: cancelledAt,
      };
      await tx.outbox.enqueue({
        id: this.deps.ids.next(),
        dedupeKey: orderCancelledDedupeKey(id),
        type: 'ORDER_CANCELLED',
        orderId: id,
        payload: buildOrderCancelledNotification(cancelled, cancelledAt),
        createdAt: cancelledAt,
      });

      return toOrderView(cancelled, items);
    });
  }
}
