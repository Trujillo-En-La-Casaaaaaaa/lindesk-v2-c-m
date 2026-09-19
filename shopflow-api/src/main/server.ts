import 'dotenv/config';
import type { Server } from 'node:http';
import { loadConfig } from '../composition/config';
import { createContainer, type Container } from '../composition/container';

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  /** Stops polling, closes the HTTP server, and closes the connection pool. */
  stop(reason: string): Promise<void>;
}

function listen(container: Container, port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = container.app.listen(port);
    server.once('listening', () => {
      container.logger.info('shopflow-api listening', {
        port,
        corsOrigin: container.config.corsOrigin,
      });
      resolve(server);
    });
    server.once('error', (error: Error) => {
      reject(error);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Starts the HTTP listener and the outbox dispatcher. Also verifies that the schema is up to
 * date, applying pending migrations when it is not (idempotent and safe alongside the
 * `shopflow-infra` migration job).
 */
export async function startServer(container: Container): Promise<RunningServer> {
  const { logger } = container;

  if (await container.migrator.isSchemaReady()) {
    logger.info('database schema is up to date', {
      migrations: container.migrator.loadMigrations().map((migration) => migration.id),
    });
  } else {
    logger.warn('database schema is not up to date; applying migrations');
    const result = await container.migrator.migrate();
    logger.info('migrations applied at startup', {
      applied: result.applied,
      skipped: result.skipped,
    });
  }

  const server = await listen(container, container.config.port);
  const address = server.address();
  const boundPort =
    address !== null && typeof address === 'object' ? address.port : container.config.port;
  container.dispatcher.start();

  let stopped = false;
  return {
    server,
    port: boundPort,
    async stop(reason: string): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      logger.info('shutting down', { reason });
      await container.dispatcher.stop(); // stop polling, finish the in-flight batch
      await closeServer(server); // stop accepting connections
      await container.close(); // close the pool
      logger.info('shutdown complete', { reason });
    },
  };
}

async function main(): Promise<void> {
  const container = createContainer(loadConfig());
  const running = await startServer(container);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const forceExit = setTimeout(() => {
      container.logger.error('shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    void running
      .stop(signal)
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        container.logger.error('shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

// Importing this module (for example from the lifecycle test) must not boot the server.
if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `server: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
