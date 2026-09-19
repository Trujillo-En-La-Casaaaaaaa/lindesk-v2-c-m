import { ValidationError } from '../../domain/errors';
import type { OrderItem, OrderView } from '../../domain/model/order';
import { toOrderView } from '../../domain/model/order';
import {
  DEFAULT_ORDER_LIST_LIMIT,
  MAX_ORDER_LIST_LIMIT,
  type ListOrders,
} from '../ports/inbound/list-orders.port';
import type { UnitOfWork } from '../ports/outbound/unit-of-work.port';

/** `limit` is optional, defaults to 50, and must be a positive integer not exceeding 200. */
export function resolveOrderListLimit(limit: unknown): number {
  if (limit === undefined || limit === null) {
    return DEFAULT_ORDER_LIST_LIMIT;
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new ValidationError('limit must be a positive integer', {
      field: 'limit',
      value: typeof limit === 'number' ? limit : null,
    });
  }
  if (limit > MAX_ORDER_LIST_LIMIT) {
    throw new ValidationError(`limit must not exceed ${MAX_ORDER_LIST_LIMIT}`, {
      field: 'limit',
      value: limit,
      max: MAX_ORDER_LIST_LIMIT,
    });
  }
  return limit;
}

export interface ListOrdersDeps {
  readonly unitOfWork: UnitOfWork;
}

/** GET /api/orders?limit=n — newest first (`created_at DESC, id DESC`). */
export class ListOrdersUseCase implements ListOrders {
  constructor(private readonly deps: ListOrdersDeps) {}

  async execute(limit?: number): Promise<readonly OrderView[]> {
    const effectiveLimit = resolveOrderListLimit(limit);
    return this.deps.unitOfWork.run(async (tx) => {
      const orders = await tx.orders.listRecent(effectiveLimit);
      if (orders.length === 0) {
        return [];
      }
      const items = await tx.orders.listItemsByOrderIds(orders.map((order) => order.id));
      const itemsByOrderId = new Map<string, OrderItem[]>();
      for (const item of items) {
        const bucket = itemsByOrderId.get(item.orderId);
        if (bucket === undefined) {
          itemsByOrderId.set(item.orderId, [item]);
        } else {
          bucket.push(item);
        }
      }
      return orders.map((order) => toOrderView(order, itemsByOrderId.get(order.id) ?? []));
    });
  }
}
