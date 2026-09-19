import type { NotificationMessage, NotificationType } from './notification.port';

export type OutboxStatus = 'PENDING' | 'SENT' | 'FAILED';

/** Durable notification intent, recorded inside the order transaction. */
export interface NewOutboxEntry {
  readonly id: string;
  readonly dedupeKey: string;
  readonly type: NotificationType;
  readonly orderId: string;
  readonly payload: NotificationMessage;
  readonly createdAt: Date;
}

export interface OutboxEntry extends NewOutboxEntry {
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly sentAt: Date | null;
}

export interface OutboxFailureResult {
  readonly status: OutboxStatus;
  readonly attempts: number;
}

/**
 * Transactional enqueue plus the dispatcher's non-transactional polling surface.
 * `dedupe_key` is UNIQUE in the database: a duplicate insert is an integrity error, never a
 * silent second notification.
 */
export interface OutboxRepository {
  enqueue(entry: NewOutboxEntry): Promise<void>;
  /** Up to `limit` PENDING rows ordered by `created_at` ascending. */
  findPending(limit: number): Promise<readonly OutboxEntry[]>;
  markSent(id: string, sentAt: Date): Promise<void>;
  /** Increments `attempts`, stores `lastError`, and marks FAILED once attempts reach maxAttempts. */
  recordFailure(id: string, lastError: string, maxAttempts: number): Promise<OutboxFailureResult>;
}
