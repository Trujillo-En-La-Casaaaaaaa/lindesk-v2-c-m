import type { OrderView } from '../../../domain/model/order';

export const DEFAULT_ORDER_LIST_LIMIT = 50;
export const MAX_ORDER_LIST_LIMIT = 200;

export interface ListOrders {
  /** Newest first. `limit` defaults to 50 and must not exceed 200. */
  execute(limit?: number): Promise<readonly OrderView[]>;
}
