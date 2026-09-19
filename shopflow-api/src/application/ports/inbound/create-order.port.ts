import type { OrderView } from '../../../domain/model/order';

export interface OrderLineInput {
  readonly productId: string;
  readonly quantity: number;
}

/** Input of POST /api/orders. */
export interface CreateOrderInput {
  readonly customerId: string;
  readonly items: readonly OrderLineInput[];
}

export interface CreateOrder {
  execute(input: CreateOrderInput): Promise<OrderView>;
}
