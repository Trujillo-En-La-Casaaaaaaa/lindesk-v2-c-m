import { describe, expect, it } from 'vitest';
import { InvalidCancellationReasonError } from '../../../src/domain/errors';
import {
  isValidCancellationReason,
  MAX_CANCELLATION_REASON_LENGTH,
  normalizeCancellationReason,
  planCancellation,
} from '../../../src/domain/model/cancellation';

describe('cancellation reason rule', () => {
  it('accepts a normal reason and trims it', () => {
    expect(normalizeCancellationReason('  Ordered the wrong size  ')).toBe(
      'Ordered the wrong size',
    );
  });

  it('accepts a reason of exactly 200 characters', () => {
    const reason = 'a'.repeat(MAX_CANCELLATION_REASON_LENGTH);
    expect(normalizeCancellationReason(reason)).toBe(reason);
    expect(reason).toHaveLength(200);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['tabs and newlines', '\t\n  \n'],
    ['201 characters', 'a'.repeat(201)],
  ])('rejects %s with INVALID_CANCELLATION_REASON', (_label, reason) => {
    expect(() => normalizeCancellationReason(reason)).toThrowError(
      InvalidCancellationReasonError,
    );
    expect(isValidCancellationReason(reason)).toBe(false);
    try {
      normalizeCancellationReason(reason);
    } catch (error) {
      expect((error as InvalidCancellationReasonError).code).toBe(
        'INVALID_CANCELLATION_REASON',
      );
    }
  });

  it('rejects non-string reasons', () => {
    expect(() => normalizeCancellationReason(undefined)).toThrowError(
      InvalidCancellationReasonError,
    );
    expect(isValidCancellationReason(42)).toBe(false);
    expect(isValidCancellationReason(null)).toBe(false);
  });

  it('measures the length after trimming', () => {
    const padded = `   ${'b'.repeat(200)}   `;
    expect(normalizeCancellationReason(padded)).toHaveLength(200);
    expect(() => normalizeCancellationReason(`   ${'b'.repeat(201)}   `)).toThrowError(
      InvalidCancellationReasonError,
    );
  });
});

describe('cancellation policy (order state machine)', () => {
  it('proceeds for CONFIRMED orders (CONFIRMED -> CANCELLED)', () => {
    expect(planCancellation({ status: 'CONFIRMED' })).toEqual({ type: 'PROCEED' });
  });

  it('rejects cancellation of SHIPPED orders', () => {
    expect(planCancellation({ status: 'SHIPPED' })).toEqual({ type: 'REJECT_SHIPPED' });
  });

  it('treats an already CANCELLED order as a no-op', () => {
    expect(planCancellation({ status: 'CANCELLED' })).toEqual({ type: 'ALREADY_CANCELLED' });
  });
});
