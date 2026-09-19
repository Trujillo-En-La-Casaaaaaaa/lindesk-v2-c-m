/**
 * Domain errors with stable codes.
 *
 * The codes are part of the frozen HTTP contract (handoff/API_CONTRACT.md): the HTTP
 * adapter maps them to status codes, so they must never change silently.
 */
export type DomainErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CANCELLATION_REASON'
  | 'PRODUCT_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'NOT_FOUND'
  | 'INSUFFICIENT_INVENTORY'
  | 'ORDER_ALREADY_SHIPPED'
  | 'ORDER_ALREADY_CANCELLED'
  | 'INTERNAL_ERROR';

export type ErrorDetails = Readonly<Record<string, unknown>>;

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: ErrorDetails;

  constructor(code: DomainErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** 400 VALIDATION_ERROR — malformed or invalid request body/query. */
export class ValidationError extends DomainError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('VALIDATION_ERROR', message, details);
  }
}

/** 400 INVALID_CANCELLATION_REASON — empty after trim, not a string, or longer than the limit. */
export class InvalidCancellationReasonError extends DomainError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('INVALID_CANCELLATION_REASON', message, details);
  }
}

/** 404 PRODUCT_NOT_FOUND — a referenced product does not exist. */
export class ProductNotFoundError extends DomainError {
  constructor(productId: string) {
    super('PRODUCT_NOT_FOUND', `Product ${productId} does not exist`, { productId });
  }
}

/** 404 ORDER_NOT_FOUND — the order id does not exist. */
export class OrderNotFoundError extends DomainError {
  constructor(orderId: string) {
    super('ORDER_NOT_FOUND', `Order ${orderId} does not exist`, { orderId });
  }
}

/** 404 NOT_FOUND — no route matches the request. */
export class RouteNotFoundError extends DomainError {
  constructor(method: string, path: string) {
    super('NOT_FOUND', `No route matches ${method} ${path}`, { method, path });
  }
}

/** 409 INSUFFICIENT_INVENTORY — requested quantity exceeds available quantity. */
export class InsufficientInventoryError extends DomainError {
  constructor(productId: string, requested: number, available: number) {
    super(
      'INSUFFICIENT_INVENTORY',
      `Product ${productId} has ${available} available but ${requested} requested`,
      { productId, requested, available },
    );
  }
}

/** 409 ORDER_ALREADY_SHIPPED — a shipped order cannot be cancelled. */
export class OrderAlreadyShippedError extends DomainError {
  constructor(orderId: string) {
    super('ORDER_ALREADY_SHIPPED', `Order ${orderId} has already been shipped`, { orderId });
  }
}

/** 409 ORDER_ALREADY_CANCELLED — a cancelled order cannot be shipped. */
export class OrderAlreadyCancelledError extends DomainError {
  constructor(orderId: string) {
    super('ORDER_ALREADY_CANCELLED', `Order ${orderId} has already been cancelled`, { orderId });
  }
}
