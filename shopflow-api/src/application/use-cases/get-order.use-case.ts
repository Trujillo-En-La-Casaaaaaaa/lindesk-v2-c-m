import { OrderNotFoundError } from '../../domain/errors';
import type { OrderView } from '../../domain/model/order';
import { toOrderView } from '../../domain/model/order';
import type { GetOrder } from '../ports/inbound/get-order.port';
import type { UnitOfWork } from '../ports/outbound/unit-of-work.port';
import { requireNonEmptyId } from './identifiers';

export interface GetOrderDeps {
  readonly unitOfWork: UnitOfWork;
}

/** GET /api/orders/:id — order detail/status view. */
export class GetOrderUseCase implements GetOrder {
  constructor(private readonly deps: GetOrderDeps) {}

  async execute(orderId: string): Promise<OrderView> {
    const id = requireNonEmptyId(orderId, 'orderId');
    return this.deps.unitOfWork.run(async (tx) => {
      const order = await tx.orders.findById(id);
      if (order === null) {
        throw new OrderNotFoundError(id);
      }
      const items = await tx.orders.listItems(id);
      return toOrderView(order, items);
    });
  }
}
