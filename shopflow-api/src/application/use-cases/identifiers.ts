import { ValidationError } from '../../domain/errors';

/** Parses an id that arrives from an untrusted caller (HTTP path parameter). */
export function requireNonEmptyId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`, { field });
  }
  return value.trim();
}
