import type { Order } from '../../domain/model/order';
import type { NotificationMessage } from '../ports/outbound/notification.port';

export function orderConfirmedDedupeKey(orderId: string): string {
  return `order:${orderId}:confirmed`;
}

export function orderCancelledDedupeKey(orderId: string): string {
  return `order:${orderId}:cancelled`;
}

/**
 * Body of the outbound notification call for an order confirmation
 * (frozen by handoff/API_CONTRACT.md). Stored verbatim as `notification_outbox.payload`.
 */
export function buildOrderConfirmedNotification(
  order: Order,
  occurredAt: Date,
): NotificationMessage {
  return {
    type: 'ORDER_CONFIRMED',
    orderId: order.id,
    customerId: order.customerId,
    recipient: `customer:${order.customerId}`,
    template: 'order-confirmed',
    occurredAt,
    dedupeKey: orderConfirmedDedupeKey(order.id),
    data: {
      status: 'CONFIRMED',
      totalCents: order.totalCents,
      currency: order.currency,
    },
  };
}

/** Same, for a cancelled order; `data` additionally carries the cancellation reason. */
export function buildOrderCancelledNotification(
  order: Order,
  occurredAt: Date,
): NotificationMessage {
  return {
    type: 'ORDER_CANCELLED',
    orderId: order.id,
    customerId: order.customerId,
    recipient: `customer:${order.customerId}`,
    template: 'order-cancelled',
    occurredAt,
    dedupeKey: orderCancelledDedupeKey(order.id),
    data: {
      status: 'CANCELLED',
      totalCents: order.totalCents,
      currency: order.currency,
      cancellationReason: order.cancellationReason,
    },
  };
}
