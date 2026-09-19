import 'dotenv/config';
import { loadConfig } from '../composition/config';
import { createContainer } from '../composition/container';

async function main(): Promise<void> {
  const container = createContainer(loadConfig({ requireNotificationProvider: false }));
  try {
    const result = await container.migrator.migrate();
    container.logger.info('migrate: done', {
      applied: result.applied,
      skipped: result.skipped,
    });
    process.exitCode = 0;
  } finally {
    await container.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `migrate: failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
