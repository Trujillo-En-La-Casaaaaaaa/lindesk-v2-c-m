import { CancelOrderUseCase } from '../../src/application/use-cases/cancel-order.use-case';
import { CreateOrderUseCase } from '../../src/application/use-cases/create-order.use-case';
import { GetOrderUseCase } from '../../src/application/use-cases/get-order.use-case';
import { ListOrdersUseCase } from '../../src/application/use-cases/list-orders.use-case';
import { ListProductsUseCase } from '../../src/application/use-cases/list-products.use-case';
import { ShipOrderUseCase } from '../../src/application/use-cases/ship-order.use-case';
import {
  createCallLog,
  FakeClock,
  InMemoryStore,
  InMemoryUnitOfWork,
  makeProduct,
  SequentialIdGenerator,
  type FakeCallLog,
} from './fakes';

export const ESPRESSO = 'prod-espresso-machine';
export const GRINDER = 'prod-burr-grinder';
export const PITCHER = 'prod-milk-pitcher';

export interface UnitFixture {
  readonly store: InMemoryStore;
  readonly calls: FakeCallLog;
  readonly unitOfWork: InMemoryUnitOfWork;
  readonly clock: FakeClock;
  readonly ids: SequentialIdGenerator;
  readonly useCases: {
    readonly createOrder: CreateOrderUseCase;
    readonly getOrder: GetOrderUseCase;
    readonly listOrders: ListOrdersUseCase;
    readonly listProducts: ListProductsUseCase;
    readonly cancelOrder: CancelOrderUseCase;
    readonly shipOrder: ShipOrderUseCase;
  };
}

/** Full use-case set wired to in-memory fakes (no database). */
export function createUnitFixture(): UnitFixture {
  const store = new InMemoryStore({
    products: [
      makeProduct({ id: ESPRESSO, name: 'Espresso Machine', priceCents: 24999 }),
      makeProduct({ id: GRINDER, name: 'Burr Coffee Grinder', priceCents: 8999 }),
      makeProduct({ id: PITCHER, name: 'Milk Pitcher', priceCents: 1999 }),
    ],
    quantities: { [ESPRESSO]: 5, [GRINDER]: 10, [PITCHER]: 25 },
  });
  const calls = createCallLog();
  const unitOfWork = new InMemoryUnitOfWork(store, calls);
  const clock = new FakeClock(new Date('2026-09-19T10:15:30.000Z'));
  const ids = new SequentialIdGenerator();

  return {
    store,
    calls,
    unitOfWork,
    clock,
    ids,
    useCases: {
      createOrder: new CreateOrderUseCase({ unitOfWork, clock, ids }),
      getOrder: new GetOrderUseCase({ unitOfWork }),
      listOrders: new ListOrdersUseCase({ unitOfWork }),
      listProducts: new ListProductsUseCase({ unitOfWork }),
      cancelOrder: new CancelOrderUseCase({ unitOfWork, clock, ids }),
      shipOrder: new ShipOrderUseCase({ unitOfWork, clock }),
    },
  };
}
