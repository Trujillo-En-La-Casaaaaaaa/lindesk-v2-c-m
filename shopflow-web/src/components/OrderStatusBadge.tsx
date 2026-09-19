import type { OrderStatus } from "../api/types";

export interface OrderStatusBadgeProps {
  status: OrderStatus;
}

const STATUS_TITLES: Record<OrderStatus, string> = {
  CONFIRMED: "Order placed and awaiting shipment",
  SHIPPED: "Order shipped; cancellation is no longer possible",
  CANCELLED: "Order cancelled; reserved inventory was restored",
};

/** Status pill with a distinct visual treatment per order status. */
export default function OrderStatusBadge({ status }: OrderStatusBadgeProps) {
  return (
    <span
      className={`status-badge status-badge-${status.toLowerCase()}`}
      data-status={status}
      title={STATUS_TITLES[status]}
    >
      {status}
    </span>
  );
}
