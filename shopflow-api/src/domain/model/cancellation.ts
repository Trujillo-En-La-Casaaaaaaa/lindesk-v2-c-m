import { InvalidCancellationReasonError } from '../errors';
import type { Order } from './order';

/** DB CHECK constraint `length(cancellation_reason) BETWEEN 1 AND 200`. */
export const MAX_CANCELLATION_REASON_LENGTH = 200;

/**
 * Cancellation reason rule: the value must be a string that is non-empty after trimming and
 * at most {@link MAX_CANCELLATION_REASON_LENGTH} characters long. The stored value is trimmed.
 */
export function normalizeCancellationReason(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new InvalidCancellationReasonError('Cancellation reason must be a string', { reason: null });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new InvalidCancellationReasonError('Cancellation reason must not be empty', {
      length: 0,
      maxLength: MAX_CANCELLATION_REASON_LENGTH,
    });
  }
  if (trimmed.length > MAX_CANCELLATION_REASON_LENGTH) {
    throw new InvalidCancellationReasonError(
      `Cancellation reason must be at most ${MAX_CANCELLATION_REASON_LENGTH} characters`,
      { length: trimmed.length, maxLength: MAX_CANCELLATION_REASON_LENGTH },
    );
  }
  return trimmed;
}

export function isValidCancellationReason(raw: unknown): boolean {
  try {
    normalizeCancellationReason(raw);
    return true;
  } catch {
    return false;
  }
}

/** Outcome of the customer cancellation transition. */
export type CancellationDecision =
  | { readonly type: 'PROCEED' }
  | { readonly type: 'ALREADY_CANCELLED' }
  | { readonly type: 'REJECT_SHIPPED' };

/**
 * Order state machine for customer cancellation.
 *
 * `ALREADY_CANCELLED` short-circuits before the reason is examined so that a repeated
 * cancellation is a no-op returning the stored result (no inventory restore, no notification).
 */
export function planCancellation(order: Pick<Order, 'status'>): CancellationDecision {
  switch (order.status) {
    case 'CANCELLED':
      return { type: 'ALREADY_CANCELLED' };
    case 'SHIPPED':
      return { type: 'REJECT_SHIPPED' };
    case 'CONFIRMED':
      return { type: 'PROCEED' };
  }
}
