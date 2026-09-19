import { useCallback, useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useApiClient } from "../App";
import { describeApiError, isApiError } from "../api/client";
import { ERROR_CODES, type OrderView } from "../api/types";
import CancelOrderForm from "../components/CancelOrderForm";
import ErrorBanner from "../components/ErrorBanner";
import OrderItemsTable from "../components/OrderItemsTable";
import OrderStatusBadge from "../components/OrderStatusBadge";
import { formatDateTime, formatMoney } from "../lib/format";

type LoadState = "loading" | "ready" | "error";
type CancelState = "idle" | "submitting";

interface RouteState {
  notice?: unknown;
}

function readRouteNotice(state: unknown): string | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const { notice } = state as RouteState;
  if (typeof notice === "string" && notice.trim().length > 0) {
    return notice;
  }
  return null;
}

/**
 * Order detail screen: full order status view plus the customer cancellation
 * form for orders that are still `CONFIRMED`.
 */
export default function OrderDetailPage() {
  const api = useApiClient();
  const { orderId } = useParams<{ orderId: string }>();
  const location = useLocation();

  const [order, setOrder] = useState<OrderView | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelState, setCancelState] = useState<CancelState>("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancellationBlocked, setCancellationBlocked] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(() => readRouteNotice(location.state));

  const loadOrder = useCallback(async (): Promise<void> => {
    if (orderId === undefined || orderId.length === 0) {
      setOrder(null);
      setLoadError("The order id is missing from the address.");
      setLoadState("error");
      return;
    }
    setLoadState("loading");
    setLoadError(null);
    try {
      const loaded = await api.getOrder(orderId);
      setOrder(loaded);
      setLoadState("ready");
    } catch (error) {
      setOrder(null);
      setLoadError(describeApiError(error));
      setLoadState("error");
    }
  }, [api, orderId]);

  useEffect(() => {
    void loadOrder();
  }, [loadOrder]);

  const cancelOrder = useCallback(
    async (reason: string): Promise<void> => {
      if (orderId === undefined || orderId.length === 0 || cancelState === "submitting") {
        return;
      }
      setCancelState("submitting");
      setCancelError(null);
      try {
        const cancelled = await api.cancelOrder(orderId, reason);
        setOrder(cancelled);
        setCancellationBlocked(false);
        setConfirmation(
          `Order ${cancelled.id} was cancelled and a cancellation notification was requested.`,
        );
      } catch (error) {
        if (isApiError(error) && error.code === ERROR_CODES.orderAlreadyShipped) {
          setCancellationBlocked(true);
          setCancelError(null);
        } else {
          setCancelError(describeApiError(error));
        }
      } finally {
        setCancelState("idle");
      }
    },
    [api, cancelState, orderId],
  );

  const canCancel = order !== null && order.status === "CONFIRMED" && !cancellationBlocked;

  return (
    <section className="page" aria-labelledby="order-heading">
      <h1 className="page-heading" id="order-heading">
        Order {orderId ?? ""}
      </h1>

      {confirmation === null ? null : (
        <p className="confirmation-banner" role="status">
          {confirmation}
        </p>
      )}

      {loadState === "loading" ? (
        <p className="state-message" role="status">
          Loading order {orderId ?? ""}…
        </p>
      ) : null}

      {loadState === "error" && loadError !== null ? (
        <ErrorBanner title="The order could not be loaded" message={loadError} />
      ) : null}

      {loadState === "ready" && order !== null ? (
        <>
          <dl className="order-summary">
            <div className="order-summary-item">
              <dt>Order id</dt>
              <dd>{order.id}</dd>
            </div>
            <div className="order-summary-item">
              <dt>Customer</dt>
              <dd>{order.customerId}</dd>
            </div>
            <div className="order-summary-item">
              <dt>Status</dt>
              <dd>
                <OrderStatusBadge status={order.status} />
              </dd>
            </div>
            <div className="order-summary-item">
              <dt>Total</dt>
              <dd>{formatMoney(order.totalCents, order.currency)}</dd>
            </div>
            <div className="order-summary-item">
              <dt>Created</dt>
              <dd>
                <time dateTime={order.createdAt}>{formatDateTime(order.createdAt)}</time>
              </dd>
            </div>
            {order.shippedAt === null ? null : (
              <div className="order-summary-item">
                <dt>Shipped</dt>
                <dd>
                  <time dateTime={order.shippedAt}>{formatDateTime(order.shippedAt)}</time>
                </dd>
              </div>
            )}
            {order.cancelledAt === null ? null : (
              <div className="order-summary-item">
                <dt>Cancelled</dt>
                <dd>
                  <time dateTime={order.cancelledAt}>{formatDateTime(order.cancelledAt)}</time>
                </dd>
              </div>
            )}
            {order.cancellationReason === null ? null : (
              <div className="order-summary-item">
                <dt>Cancellation reason</dt>
                <dd>{order.cancellationReason}</dd>
              </div>
            )}
          </dl>

          <OrderItemsTable items={order.items} currency={order.currency} />

          {cancellationBlocked ? (
            <ErrorBanner
              title="Order already shipped"
              message="Shipped orders cannot be cancelled, so this order was left unchanged."
            />
          ) : null}

          {canCancel ? (
            <CancelOrderForm submitting={cancelState === "submitting"} errorMessage={cancelError} onCancel={cancelOrder} />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
