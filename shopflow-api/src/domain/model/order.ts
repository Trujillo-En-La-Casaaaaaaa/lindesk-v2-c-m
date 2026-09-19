export type OrderStatus = 'CONFIRMED' | 'SHIPPED' | 'CANCELLED';

export const ORDER_STATUSES: readonly OrderStatus[] = ['CONFIRMED', 'SHIPPED', 'CANCELLED'];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly status: OrderStatus;
  readonly totalCents: number;
  readonly currency: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly shippedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancellationReason: string | null;
}

export interface OrderItem {
  readonly id: string;
  readonly orderId: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
}

/** Wire shape frozen by handoff/API_CONTRACT.md (Order item view). */
export interface OrderItemView {
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
}

/** Wire shape frozen by handoff/API_CONTRACT.md (Order view). */
export interface OrderView {
  readonly id: string;
  readonly customerId: string;
  readonly status: OrderStatus;
  readonly totalCents: number;
  readonly currency: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly shippedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancellationReason: string | null;
  readonly items: readonly OrderItemView[];
}

export function lineTotalCents(unitPriceCents: number, quantity: number): number {
  return unitPriceCents * quantity;
}

export function orderTotalCents(
  items: readonly Pick<OrderItem, 'unitPriceCents' | 'quantity'>[],
): number {
  return items.reduce((total, item) => total + lineTotalCents(item.unitPriceCents, item.quantity), 0);
}

export function toOrderItemView(item: OrderItem): OrderItemView {
  return {
    productId: item.productId,
    productName: item.productName,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    lineTotalCents: item.lineTotalCents,
  };
}

function toIsoString(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toOrderView(order: Order, items: readonly OrderItem[]): OrderView {
  return {
    id: order.id,
    customerId: order.customerId,
    status: order.status,
    totalCents: order.totalCents,
    currency: order.currency,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    shippedAt: toIsoString(order.shippedAt),
    cancelledAt: toIsoString(order.cancelledAt),
    cancellationReason: order.cancellationReason,
    items: items.map(toOrderItemView),
  };
}

/** Outcome of the administrative SHIPPED transition. */
export type ShipmentDecision =
  | { readonly type: 'PROCEED' }
  | { readonly type: 'ALREADY_SHIPPED' }
  | { readonly type: 'REJECT_CANCELLED' };

/** Order state machine for the administrative SHIPPED action. */
export function planShipment(order: Pick<Order, 'status'>): ShipmentDecision {
  switch (order.status) {
    case 'SHIPPED':
      return { type: 'ALREADY_SHIPPED' };
    case 'CANCELLED':
      return { type: 'REJECT_CANCELLED' };
    case 'CONFIRMED':
      return { type: 'PROCEED' };
  }
}
