import type { OrderView } from '../../../domain/model/order';

export interface CancelOrder {
  /**
   * Cancels a CONFIRMED order (restores inventory once and records one ORDER_CANCELLED intent),
   * rejects a SHIPPED order, and treats a repeat cancellation as a no-op returning the stored
   * `cancelledAt`/`cancellationReason`.
   */
  execute(orderId: string, reason: unknown): Promise<OrderView>;
}
