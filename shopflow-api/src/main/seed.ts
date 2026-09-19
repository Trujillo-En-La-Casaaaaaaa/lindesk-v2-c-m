import 'dotenv/config';
import { loadConfig } from '../composition/config';
import { createContainer } from '../composition/container';

async function main(): Promise<void> {
  const container = createContainer(loadConfig({ requireNotificationProvider: false }));
  try {
    if (!(await container.migrator.isSchemaReady())) {
      container.logger.warn('seed: schema not up to date; applying migrations first');
      await container.migrator.migrate();
    }
    const result = await container.seeder.run();
    // Single machine-readable summary line on stdout, as required by handoff/SEED_DATA.md.
    process.stdout.write(`seed: products=${result.products} inventory=${result.inventory}\n`);
    process.exitCode = 0;
  } finally {
    await container.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `seed: failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
