import { createContainer, type Container } from '../../src/composition/container';
import type { AppConfig } from '../../src/composition/config';
import { silentLogger } from './fakes';
import { MIGRATIONS_DIR, TEST_DATABASE_URL } from './database';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    notificationProviderUrl: 'http://127.0.0.1:9',
    corsOrigin: 'http://localhost:3000',
    outboxPollIntervalMs: 25,
    outboxMaxAttempts: 3,
    logLevel: 'error',
    migrationsDir: MIGRATIONS_DIR,
    ...overrides,
  };
}

/** Container wired against the test database, with logging silenced. */
export function createTestContainer(overrides: Partial<AppConfig> = {}): Container {
  return createContainer(testConfig(overrides), silentLogger);
}
