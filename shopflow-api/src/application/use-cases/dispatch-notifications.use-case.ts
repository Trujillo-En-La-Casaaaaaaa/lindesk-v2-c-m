import type { Clock } from '../ports/outbound/clock.port';
import type { Logger } from '../ports/outbound/logger.port';
import type { NotificationPort } from '../ports/outbound/notification.port';
import type { OutboxRepository } from '../ports/outbound/outbox-repository.port';

/** The dispatcher takes at most this many PENDING rows per poll (frozen by the handoff). */
export const OUTBOX_BATCH_SIZE = 50;

export interface DispatchBatchResult {
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
}

export interface DispatchNotificationsDeps {
  readonly outbox: OutboxRepository;
  readonly notifications: NotificationPort;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly pollIntervalMs: number;
  readonly maxAttempts: number;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/**
 * Outbox dispatcher.
 *
 * Polls `notification_outbox` for PENDING rows and delivers each through the
 * NotificationPort. Delivery is at-least-once: the provider deduplicates on
 * `Idempotency-Key`, so a retry cannot produce a second logical notification.
 * Success marks the row SENT; failure increments attempts and only marks FAILED once the
 * configured attempt budget is exhausted.
 */
export class DispatchNotifications {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: DispatchNotificationsDeps) {}

  /** Starts the polling loop. Safe to call more than once. */
  start(): void {
    if (this.stopped) {
      this.deps.logger.warn('outbox dispatcher is stopped and cannot be started again');
      return;
    }
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.pollIntervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    this.deps.logger.info('outbox dispatcher started', {
      pollIntervalMs: this.deps.pollIntervalMs,
      maxAttempts: this.deps.maxAttempts,
    });
  }

  /** Stops polling, waits for the in-flight batch to finish, and refuses further batches. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.running !== null) {
      await this.running;
    }
    this.deps.logger.info('outbox dispatcher stopped');
  }

  /** Processes one batch and returns its counters (used by tests and by the poll timer). */
  async runBatch(): Promise<DispatchBatchResult> {
    const entries = await this.deps.outbox.findPending(OUTBOX_BATCH_SIZE);
    let sent = 0;
    let retried = 0;
    let failed = 0;

    for (const entry of entries) {
      try {
        await this.deps.notifications.send(entry.payload);
        await this.deps.outbox.markSent(entry.id, this.deps.clock.now());
        sent += 1;
        this.deps.logger.debug('notification delivered', {
          outboxId: entry.id,
          dedupeKey: entry.dedupeKey,
          type: entry.type,
        });
      } catch (error) {
        const lastError = describeError(error);
        const outcome = await this.deps.outbox.recordFailure(
          entry.id,
          lastError,
          this.deps.maxAttempts,
        );
        if (outcome.status === 'FAILED') {
          failed += 1;
          this.deps.logger.error('notification delivery failed permanently', {
            outboxId: entry.id,
            dedupeKey: entry.dedupeKey,
            type: entry.type,
            attempts: outcome.attempts,
            error: lastError,
          });
        } else {
          retried += 1;
          this.deps.logger.warn('notification delivery failed; will retry', {
            outboxId: entry.id,
            dedupeKey: entry.dedupeKey,
            type: entry.type,
            attempts: outcome.attempts,
            error: lastError,
          });
        }
      }
    }

    return { claimed: entries.length, sent, retried, failed };
  }

  private tick(): Promise<void> {
    if (this.running !== null) {
      return this.running;
    }
    this.running = this.executeBatch();
    return this.running;
  }

  private async executeBatch(): Promise<void> {
    try {
      const result = await this.runBatch();
      if (result.claimed > 0) {
        this.deps.logger.debug('outbox batch processed', { ...result });
      }
    } catch (error) {
      this.deps.logger.error('outbox batch failed', { error: describeError(error) });
    } finally {
      this.running = null;
    }
  }
}
