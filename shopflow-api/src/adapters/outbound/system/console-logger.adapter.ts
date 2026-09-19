import type { Logger, LogLevel, LogMeta } from '../../../application/ports/outbound/logger.port';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function describeMetaValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
}

/**
 * Structured logger writing one JSON object per line. `debug`/`info` go to stdout,
 * `warn`/`error` to stderr, which keeps machine-read stdout (for example the seed summary
 * line) free of diagnostics.
 */
export class ConsoleLogger implements Logger {
  constructor(private readonly level: LogLevel = 'info') {}

  debug(message: string, meta?: LogMeta): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: LogMeta): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    this.write('error', message, meta);
  }

  private write(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) {
      return;
    }
    const entry: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      message,
    };
    if (meta !== undefined) {
      for (const [key, value] of Object.entries(meta)) {
        entry[key] = describeMetaValue(value);
      }
    }
    const line = `${JSON.stringify(entry)}\n`;
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }
}
