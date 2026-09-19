import type { Express } from 'express';
import { Pool } from 'pg';
import { CancelOrderUseCase } from '../application/use-cases/cancel-order.use-case';
import { CreateOrderUseCase } from '../application/use-cases/create-order.use-case';
import { DispatchNotifications } from '../application/use-cases/dispatch-notifications.use-case';
import { GetOrderUseCase } from '../application/use-cases/get-order.use-case';
import { ListOrdersUseCase } from '../application/use-cases/list-orders.use-case';
import { ListProductsUseCase } from '../application/use-cases/list-products.use-case';
import { ShipOrderUseCase } from '../application/use-cases/ship-order.use-case';
import type { Logger } from '../application/ports/outbound/logger.port';
import type { UnitOfWork } from '../application/ports/outbound/unit-of-work.port';
import { createHttpApp, type HttpServerUseCases } from '../adapters/inbound/http/server';
import { HttpNotificationAdapter } from '../adapters/outbound/notification/http-notification.adapter';
import { PostgresMigrator } from '../adapters/outbound/persistence/postgres/migrator';
import { PgSqlExecutor } from '../adapters/outbound/persistence/postgres/pg-sql-executor';
import { PostgresOutboxRepository } from '../adapters/outbound/persistence/postgres/postgres-outbox.repository';
import { PostgresSeeder } from '../adapters/outbound/persistence/postgres/postgres-seeder';
import { PostgresUnitOfWork } from '../adapters/outbound/persistence/postgres/postgres-unit-of-work';
import { ConsoleLogger } from '../adapters/outbound/system/console-logger.adapter';
import { SystemClock } from '../adapters/outbound/system/system-clock.adapter';
import { UuidIdGenerator } from '../adapters/outbound/system/uuid-id-generator.adapter';
import type { AppConfig } from './config';

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly unitOfWork: UnitOfWork;
  readonly useCases: HttpServerUseCases;
  readonly migrator: PostgresMigrator;
  readonly seeder: PostgresSeeder;
  readonly dispatcher: DispatchNotifications;
  readonly app: Express;
  /** Stops the dispatcher and closes the connection pool. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Composition root: the only module that constructs concrete adapters and wires them into
 * use cases. Everything else depends on ports only.
 */
export function createContainer(config: AppConfig, logger?: Logger): Container {
  const activeLogger = logger ?? new ConsoleLogger(config.logLevel);

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 10_000,
    application_name: 'shopflow-api',
  });
  pool.on('error', (error: Error) => {
    activeLogger.error('idle postgres client error', { error: error.message });
  });

  const unitOfWork = new PostgresUnitOfWork(pool, { logger: activeLogger });
  const clock = new SystemClock();
  const ids = new UuidIdGenerator();

  // Dispatcher reads and updates outbox rows outside order transactions.
  const outbox = new PostgresOutboxRepository(new PgSqlExecutor(pool));
  const notifications = new HttpNotificationAdapter({ baseUrl: config.notificationProviderUrl });

  const useCases: HttpServerUseCases = {
    createOrder: new CreateOrderUseCase({ unitOfWork, clock, ids }),
    getOrder: new GetOrderUseCase({ unitOfWork }),
    listOrders: new ListOrdersUseCase({ unitOfWork }),
    listProducts: new ListProductsUseCase({ unitOfWork }),
    cancelOrder: new CancelOrderUseCase({ unitOfWork, clock, ids }),
    shipOrder: new ShipOrderUseCase({ unitOfWork, clock }),
  };

  const dispatcher = new DispatchNotifications({
    outbox,
    notifications,
    clock,
    logger: activeLogger,
    pollIntervalMs: config.outboxPollIntervalMs,
    maxAttempts: config.outboxMaxAttempts,
  });

  const app = createHttpApp({
    corsOrigin: config.corsOrigin,
    logger: activeLogger,
    databaseProbe: unitOfWork,
    useCases,
  });

  const migrator = new PostgresMigrator(pool, {
    migrationsDir: config.migrationsDir,
    logger: activeLogger,
  });
  const seeder = new PostgresSeeder(pool);

  let closed = false;
  return {
    config,
    logger: activeLogger,
    unitOfWork,
    useCases,
    migrator,
    seeder,
    dispatcher,
    app,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await dispatcher.stop();
      await unitOfWork.close();
    },
  };
}
