/**
 * TypeScript mirror of the frozen ShopFlow API contract
 * (`.handoff/UI_CONTRACT.md`). The browser only relies on these shapes;
 * no endpoint, field or status beyond this file is assumed anywhere in the app.
 */

export type OrderStatus = "CONFIRMED" | "SHIPPED" | "CANCELLED";

export interface ProductView {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  availableQuantity: number;
}

export interface OrderItemView {
  productId: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface OrderView {
  id: string;
  customerId: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  shippedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  items: OrderItemView[];
}

export interface CreateOrderItemInput {
  productId: string;
  quantity: number;
}

export interface CreateOrderInput {
  customerId: string;
  items: CreateOrderItemInput[];
}

/** The single error envelope shape used by every ShopFlow API endpoint. */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** `INSUFFICIENT_INVENTORY` error details as defined by the API contract. */
export interface InsufficientInventoryDetails {
  productId: string;
  requested: number;
  available: number;
}

/** Error codes the UI reacts to explicitly. */
export const ERROR_CODES = {
  validationError: "VALIDATION_ERROR",
  productNotFound: "PRODUCT_NOT_FOUND",
  insufficientInventory: "INSUFFICIENT_INVENTORY",
  orderNotFound: "ORDER_NOT_FOUND",
  invalidCancellationReason: "INVALID_CANCELLATION_REASON",
  orderAlreadyShipped: "ORDER_ALREADY_SHIPPED",
  orderAlreadyCancelled: "ORDER_ALREADY_CANCELLED",
} as const;

/** Client-side mirror of the backend limit, measured on the trimmed reason. */
export const CANCELLATION_REASON_MAX_LENGTH = 200;
