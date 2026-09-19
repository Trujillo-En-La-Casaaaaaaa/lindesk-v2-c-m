import cors from 'cors';
import express, { type Express } from 'express';
import type { CancelOrder } from '../../../application/ports/inbound/cancel-order.port';
import type { CreateOrder } from '../../../application/ports/inbound/create-order.port';
import type { GetOrder } from '../../../application/ports/inbound/get-order.port';
import type { ListOrders } from '../../../application/ports/inbound/list-orders.port';
import type { ListProducts } from '../../../application/ports/inbound/list-products.port';
import type { ShipOrder } from '../../../application/ports/inbound/ship-order.port';
import type { Logger } from '../../../application/ports/outbound/logger.port';
import type { DatabaseProbe } from '../../../application/ports/outbound/unit-of-work.port';
import { RouteNotFoundError } from '../../../domain/errors';
import { handle } from './async-handler';
import { createErrorHandler } from './problem';
import { createAdminRouter } from './routes/admin.routes';
import { createCatalogRouter } from './routes/catalog.routes';
import { createOrderRouter } from './routes/order.routes';

export interface HttpServerUseCases {
  readonly createOrder: CreateOrder;
  readonly getOrder: GetOrder;
  readonly listOrders: ListOrders;
  readonly listProducts: ListProducts;
  readonly cancelOrder: CancelOrder;
  readonly shipOrder: ShipOrder;
}

export interface HttpServerOptions {
  readonly corsOrigin: string;
  readonly logger: Logger;
  readonly databaseProbe: DatabaseProbe;
  readonly useCases: HttpServerUseCases;
}

/**
 * Express app factory. It never calls `listen`, so the same wiring is used by the server
 * entrypoint and by the contract tests.
 */
export function createHttpApp(options: HttpServerOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: options.corsOrigin }));
  app.use(express.json({ limit: '256kb' }));

  app.get(
    '/health',
    handle(async (_req, res) => {
      const databaseUp = await options.databaseProbe.probe();
      if (databaseUp) {
        res.status(200).json({ status: 'ok', database: 'up' });
        return;
      }
      options.logger.warn('health check degraded: database unreachable');
      res.status(503).json({ status: 'degraded', database: 'down' });
    }),
  );

  app.use(
    '/api',
    createCatalogRouter({ listProducts: options.useCases.listProducts }),
    createOrderRouter({
      createOrder: options.useCases.createOrder,
      getOrder: options.useCases.getOrder,
      listOrders: options.useCases.listOrders,
      cancelOrder: options.useCases.cancelOrder,
    }),
    createAdminRouter({ shipOrder: options.useCases.shipOrder }),
  );

  // Unknown routes (and unknown methods on known paths) -> 404 NOT_FOUND envelope.
  app.use((req, _res, next) => {
    next(new RouteNotFoundError(req.method, req.originalUrl));
  });

  app.use(createErrorHandler(options.logger));
  return app;
}
