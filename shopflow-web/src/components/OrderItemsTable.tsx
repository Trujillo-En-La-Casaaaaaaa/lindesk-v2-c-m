import type { OrderItemView } from "../api/types";
import { formatMoney } from "../lib/format";

export interface OrderItemsTableProps {
  items: OrderItemView[];
  currency: string;
}

/** Line items of an order, with quantities, unit prices and line totals. */
export default function OrderItemsTable({ items, currency }: OrderItemsTableProps) {
  return (
    <table className="order-items-table">
      <caption className="table-caption">Line items</caption>
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col">Quantity</th>
          <th scope="col">Unit price</th>
          <th scope="col">Line total</th>
        </tr>
      </thead>
      <tbody>
        {items.length === 0 ? (
          <tr>
            <td colSpan={4}>This order has no line items.</td>
          </tr>
        ) : (
          items.map((item) => (
            <tr key={item.productId}>
              <th scope="row">{item.productName}</th>
              <td>{item.quantity}</td>
              <td>{formatMoney(item.unitPriceCents, currency)}</td>
              <td>{formatMoney(item.lineTotalCents, currency)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
