export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogMeta = Readonly<Record<string, unknown>>;

/**
 * Logging port. Application code and adapters depend on this interface so that no
 * framework-specific logger leaks into the core.
 */
export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}
