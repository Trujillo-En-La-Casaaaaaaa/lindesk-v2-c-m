import { ValidationError } from '../../../domain/errors';

/** Path parameters must be non-empty strings; anything else is a malformed request. */
export function parsePathId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

/**
 * `limit` query parameter: optional digits. Range rules (positive, <= 200, default 50) live in
 * the ListOrders use case so the HTTP layer and any other caller share one implementation.
 */
export function parseOrderListLimit(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new ValidationError('limit must be a positive integer', { field: 'limit' });
  }
  return Number.parseInt(raw.trim(), 10);
}

/** `reason` of the cancellation body. Validated by the domain rule in the use case. */
export function parseCancellationReason(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }
  return (body as Record<string, unknown>)['reason'];
}
