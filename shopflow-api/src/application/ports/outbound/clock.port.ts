/** Time source. Use cases never call `new Date()` directly, so behaviour stays testable. */
export interface Clock {
  now(): Date;
}
