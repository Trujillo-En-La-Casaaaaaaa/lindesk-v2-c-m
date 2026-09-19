import { useState, type FormEvent } from "react";
import type { ProductView } from "../api/types";
import { formatMoney } from "../lib/format";

export interface ProductCardProps {
  product: ProductView;
  /** True while this product's order creation request is in flight. */
  submitting?: boolean;
  onCreateOrder: (product: ProductView, quantity: number) => void;
}

/**
 * Catalog entry: product facts, availability and the quantity selector that
 * creates a single-line order. Availability is always rendered from the API
 * response; the backend remains the only inventory authority.
 */
export default function ProductCard({ product, submitting = false, onCreateOrder }: ProductCardProps) {
  const [quantityInput, setQuantityInput] = useState("1");

  const trimmedQuantity = quantityInput.trim();
  const parsedQuantity = /^\d+$/.test(trimmedQuantity) ? Number.parseInt(trimmedQuantity, 10) : Number.NaN;
  const quantityIsValid = Number.isInteger(parsedQuantity) && parsedQuantity > 0;

  const quantityFieldId = `quantity-${product.id}`;
  const quantityHintId = `quantity-hint-${product.id}`;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!quantityIsValid || submitting) {
      return;
    }
    onCreateOrder(product, parsedQuantity);
  }

  return (
    <article className="product-card">
      <h2 className="product-name">{product.name}</h2>
      <p className="product-sku">SKU {product.sku}</p>
      <p className="product-description">{product.description}</p>
      <p className="product-price">Price: {formatMoney(product.priceCents, product.currency)}</p>
      <p className="product-availability">Available quantity: {product.availableQuantity}</p>
      <form className="product-order-form" onSubmit={handleSubmit} noValidate>
        <label className="field-label" htmlFor={quantityFieldId}>
          Quantity
        </label>
        <input
          id={quantityFieldId}
          className="field-input"
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={quantityInput}
          onChange={(event) => setQuantityInput(event.target.value)}
          aria-describedby={quantityHintId}
          aria-invalid={!quantityIsValid}
          disabled={submitting}
        />
        <p className="field-hint" id={quantityHintId}>
          {quantityIsValid ? `Order ${parsedQuantity} × ${product.name}` : "Enter a whole number of 1 or more."}
        </p>
        <button className="button" type="submit" disabled={!quantityIsValid || submitting}>
          {submitting ? "Creating order…" : "Create order"}
        </button>
      </form>
    </article>
  );
}
