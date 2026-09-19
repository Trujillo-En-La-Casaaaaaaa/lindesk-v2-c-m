import type { LogLevel } from '../application/ports/outbound/logger.port';

/** Fully resolved runtime configuration. */
export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly notificationProviderUrl: string;
  readonly corsOrigin: string;
  readonly outboxPollIntervalMs: number;
  readonly outboxMaxAttempts: number;
  readonly logLevel: LogLevel;
  readonly migrationsDir: string | undefined;
}

export class ConfigurationError extends Error {}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LoadConfigOptions {
  /** Environment source; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The API process must know where the notification provider lives; `migrate` and `seed` do
   * not, so they relax this requirement.
   */
  readonly requireNotificationProvider?: boolean;
}

function readString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readString(env, name);
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigurationError(`${name} must be an integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new ConfigurationError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = readString(env, 'DATABASE_URL');
  if (raw === undefined) {
    throw new ConfigurationError('DATABASE_URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError('DATABASE_URL must be a valid connection string');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ConfigurationError('DATABASE_URL must use the postgres:// or postgresql:// scheme');
  }
  return raw;
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = readString(env, 'LOG_LEVEL');
  if (raw === undefined) {
    return 'info';
  }
  const level = LOG_LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) {
    throw new ConfigurationError(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);
  }
  return level;
}

/** Validates the provider URL shape so a typo fails at startup, not at first delivery. */
function validateNotificationProviderUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError('NOTIFICATION_PROVIDER_URL must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigurationError('NOTIFICATION_PROVIDER_URL must use the http:// or https:// scheme');
  }
}

/**
 * Parses environment variables with the defaults documented in the frozen contract
 * (handoff/API_CONTRACT.md). Invalid values fail fast with a precise message instead of
 * silently falling back.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const requireNotificationProvider = options.requireNotificationProvider ?? true;

  const notificationProviderUrl = readString(env, 'NOTIFICATION_PROVIDER_URL');
  if (requireNotificationProvider && notificationProviderUrl === undefined) {
    throw new ConfigurationError('NOTIFICATION_PROVIDER_URL is required');
  }
  if (notificationProviderUrl !== undefined) {
    validateNotificationProviderUrl(notificationProviderUrl);
  }

  return {
    port: readInteger(env, 'PORT', 8080, 1, 65_535),
    databaseUrl: readDatabaseUrl(env),
    notificationProviderUrl: notificationProviderUrl ?? '',
    corsOrigin: readString(env, 'CORS_ORIGIN') ?? 'http://localhost:3000',
    outboxPollIntervalMs: readInteger(env, 'OUTBOX_POLL_INTERVAL_MS', 250, 1, 3_600_000),
    outboxMaxAttempts: readInteger(env, 'OUTBOX_MAX_ATTEMPTS', 10, 1, 100),
    logLevel: readLogLevel(env),
    migrationsDir: readString(env, 'MIGRATIONS_DIR'),
  };
}
