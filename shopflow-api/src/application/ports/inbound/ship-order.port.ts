import type { OrderView } from '../../../domain/model/order';

export interface ShipOrder {
  /** Administrative action: marks a CONFIRMED order SHIPPED; a repeat request is idempotent. */
  execute(orderId: string): Promise<OrderView>;
}
