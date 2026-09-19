import type { NotificationMessage, NotificationType } from '../../../../application/ports/outbound/notification.port';
import type {
  NewOutboxEntry,
  OutboxEntry,
  OutboxFailureResult,
  OutboxRepository,
  OutboxStatus,
} from '../../../../application/ports/outbound/outbox-repository.port';
import type { SqlExecutor } from '../../../../application/ports/outbound/sql-executor.port';

interface OutboxRow {
  id: string;
  dedupe_key: string;
  type: string;
  order_id: string;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  sent_at: Date | null;
}

const OUTBOX_COLUMNS = `id, dedupe_key, type, order_id, payload, status, attempts, last_error,
                        created_at, sent_at`;

function isNotificationType(value: string): value is NotificationType {
  return value === 'ORDER_CONFIRMED' || value === 'ORDER_CANCELLED';
}

function isOutboxStatus(value: string): value is OutboxStatus {
  return value === 'PENDING' || value === 'SENT' || value === 'FAILED';
}

function requireStringField(payload: Record<string, unknown>, key: string, rowId: string): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw new Error(`notification_outbox row ${rowId} has an invalid payload.${key}`);
  }
  return value;
}

function toNotificationMessage(row: OutboxRow): NotificationMessage {
  if (typeof row.payload !== 'object' || row.payload === null || Array.isArray(row.payload)) {
    throw new Error(`notification_outbox row ${row.id} has a non-object payload`);
  }
  const payload = row.payload as Record<string, unknown>;
  const template = payload['template'];
  if (template !== 'order-confirmed' && template !== 'order-cancelled') {
    throw new Error(`notification_outbox row ${row.id} has an invalid payload.template`);
  }
  const occurredAtRaw = requireStringField(payload, 'occurredAt', row.id);
  const occurredAt = new Date(occurredAtRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error(`notification_outbox row ${row.id} has an invalid payload.occurredAt`);
  }
  const rawData = payload['data'];
  if (typeof rawData !== 'object' || rawData === null || Array.isArray(rawData)) {
    throw new Error(`notification_outbox row ${row.id} has an invalid payload.data`);
  }
  if (!isNotificationType(row.type)) {
    throw new Error(`notification_outbox row ${row.id} has an unsupported type`);
  }
  return {
    type: row.type,
    orderId: row.order_id,
    customerId: requireStringField(payload, 'customerId', row.id),
    recipient: requireStringField(payload, 'recipient', row.id),
    template,
    occurredAt,
    dedupeKey: row.dedupe_key,
    data: rawData as Record<string, unknown>,
  };
}

function toOutboxEntry(row: OutboxRow): OutboxEntry {
  if (!isOutboxStatus(row.status)) {
    throw new Error(`notification_outbox row ${row.id} has an unsupported status`);
  }
  const payload = toNotificationMessage(row);
  if (!isNotificationType(row.type)) {
    throw new Error(`notification_outbox row ${row.id} has an unsupported type`);
  }
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    type: row.type,
    orderId: row.order_id,
    payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

function serializePayload(message: NotificationMessage): string {
  return JSON.stringify({ ...message, occurredAt: message.occurredAt.toISOString() });
}

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly executor: SqlExecutor) {}

  /**
   * Records durable notification intent. There is deliberately no ON CONFLICT clause: the
   * UNIQUE constraint on `dedupe_key` must surface a double enqueue as an error instead of
   * silently producing a second logical notification.
   */
  async enqueue(entry: NewOutboxEntry): Promise<void> {
    await this.executor.query(
      `INSERT INTO notification_outbox (id, dedupe_key, type, order_id, payload, status, attempts,
                                        created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', 0, $6)`,
      [entry.id, entry.dedupeKey, entry.type, entry.orderId, serializePayload(entry.payload), entry.createdAt],
    );
  }

  async findPending(limit: number): Promise<readonly OutboxEntry[]> {
    const result = await this.executor.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS}
         FROM notification_outbox
        WHERE status = 'PENDING'
        ORDER BY created_at ASC, id ASC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(toOutboxEntry);
  }

  async markSent(id: string, sentAt: Date): Promise<void> {
    await this.executor.query(
      `UPDATE notification_outbox
          SET status = 'SENT', sent_at = $2, last_error = NULL
        WHERE id = $1`,
      [id, sentAt],
    );
  }

  async recordFailure(
    id: string,
    lastError: string,
    maxAttempts: number,
  ): Promise<OutboxFailureResult> {
    const result = await this.executor.query<{ status: string; attempts: number }>(
      `UPDATE notification_outbox
          SET attempts = attempts + 1,
              last_error = $2,
              status = CASE WHEN attempts + 1 >= $3 THEN 'FAILED' ELSE 'PENDING' END
        WHERE id = $1
        RETURNING status, attempts`,
      [id, lastError, maxAttempts],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`notification_outbox row ${id} disappeared while recording a failure`);
    }
    if (!isOutboxStatus(row.status)) {
      throw new Error(`notification_outbox row ${id} has an unsupported status`);
    }
    return { status: row.status, attempts: row.attempts };
  }
}
