import type { Clock } from '../../../application/ports/outbound/clock.port';

/** Production clock. Tests use their own deterministic clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
