import { useCallback, useEffect, useState } from "react";
import { useApiClient } from "../App";
import { describeApiError, isApiError } from "../api/client";
import { ERROR_CODES, type OrderView } from "../api/types";
import ErrorBanner from "../components/ErrorBanner";
import OrderStatusBadge from "../components/OrderStatusBadge";
import { formatDateTime, formatMoney } from "../lib/format";

type LoadState = "loading" | "ready" | "error";

/** Number of orders requested from `GET /api/orders`; the contract default. */
const ORDER_LIST_LIMIT = 50;

/**
 * Administrative screen: lists orders and lets the administrator mark a
 * `CONFIRMED` order as `SHIPPED`.
 */
export default function AdminOrdersPage() {
  const api = useApiClient();

  const [orders, setOrders] = useState<OrderView[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shipError, setShipError] = useState<string | null>(null);
  const [alreadyCancelledError, setAlreadyCancelledError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [shippingOrderId, setShippingOrderId] = useState<string | null>(null);

  const loadOrders = useCallback(async (): Promise<void> => {
    setLoadState("loading");
    setLoadError(null);
    try {
      const loaded = await api.listOrders(ORDER_LIST_LIMIT);
      setOrders(loaded);
      setLoadState("ready");
    } catch (error) {
      setOrders([]);
      setLoadError(describeApiError(error));
      setLoadState("error");
    }
  }, [api]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const shipOrder = useCallback(
    async (order: OrderView): Promise<void> => {
      if (shippingOrderId !== null) {
        return;
      }
      setShippingOrderId(order.id);
      setShipError(null);
      setAlreadyCancelledError(null);
      setConfirmation(null);
      try {
        const shipped = await api.shipOrder(order.id);
        setConfirmation(`Order ${shipped.id} was marked as SHIPPED and a shipping notification was requested.`);
        await loadOrders();
      } catch (error) {
        if (isApiError(error) && error.code === ERROR_CODES.orderAlreadyCancelled) {
          setAlreadyCancelledError(`Order ${order.id} was already cancelled, so it cannot be marked as SHIPPED.`);
        } else {
          setShipError(describeApiError(error));
        }
      } finally {
        setShippingOrderId(null);
      }
    },
    [api, loadOrders, shippingOrderId],
  );

  return (
    <section className="page" aria-labelledby="admin-heading">
      <h1 className="page-heading" id="admin-heading">
        Admin orders
      </h1>

      {confirmation === null ? null : (
        <p className="confirmation-banner" role="status">
          {confirmation}
        </p>
      )}
      {shipError === null ? null : <ErrorBanner title="The order was not shipped" message={shipError} />}
      {alreadyCancelledError === null ? null : (
        <ErrorBanner title="The order was already cancelled" message={alreadyCancelledError} />
      )}

      {loadState === "loading" && orders.length === 0 ? (
        <p className="state-message" role="status">
          Loading orders…
        </p>
      ) : null}

      {loadState === "error" && loadError !== null ? (
        <ErrorBanner title="The orders could not be loaded" message={loadError} />
      ) : null}

      {loadState !== "error" && orders.length === 0 && loadState === "ready" ? (
        <p className="state-message">No orders have been placed yet.</p>
      ) : null}

      {orders.length > 0 ? (
        <table className="orders-table">
          <caption className="table-caption">All orders</caption>
          <thead>
            <tr>
              <th scope="col">Order id</th>
              <th scope="col">Customer</th>
              <th scope="col">Status</th>
              <th scope="col">Total</th>
              <th scope="col">Created</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <th scope="row">{order.id}</th>
                <td>{order.customerId}</td>
                <td>
                  <OrderStatusBadge status={order.status} />
                </td>
                <td>{formatMoney(order.totalCents, order.currency)}</td>
                <td>
                  <time dateTime={order.createdAt}>{formatDateTime(order.createdAt)}</time>
                </td>
                <td>
                  <button
                    className="button"
                    type="button"
                    disabled={order.status !== "CONFIRMED" || shippingOrderId !== null}
                    onClick={() => {
                      void shipOrder(order);
                    }}
                  >
                    {shippingOrderId === order.id ? "Marking as SHIPPED…" : "Mark as SHIPPED"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
