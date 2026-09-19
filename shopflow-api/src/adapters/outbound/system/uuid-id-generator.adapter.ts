import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../../../application/ports/outbound/id-generator.port';

/** UUID v4 based identifier generator for order ids, order item ids, and outbox ids. */
export class UuidIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
