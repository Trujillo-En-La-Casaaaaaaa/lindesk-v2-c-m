/** Source of unique identifiers for orders, order items, and outbox rows. */
export interface IdGenerator {
  next(): string;
}
