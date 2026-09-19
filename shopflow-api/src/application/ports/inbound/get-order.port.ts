import type { OrderView } from '../../../domain/model/order';

export interface GetOrder {
  execute(orderId: string): Promise<OrderView>;
}
