import type {
  NotificationMessage,
  NotificationPort,
} from '../../../application/ports/outbound/notification.port';

export interface HttpNotificationAdapterOptions {
  /** Base URL of the provider (locally the deterministic emulator); path `/notifications` is appended. */
  readonly baseUrl: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

async function readBodySafely(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 200 ? `${text.slice(0, 200)}...` : text;
  } catch {
    return '';
  }
}

/**
 * HTTP implementation of the outbound notification port.
 *
 * `POST ${NOTIFICATION_PROVIDER_URL}/notifications` with `Idempotency-Key: <dedupeKey>`.
 * The provider answers `202` for both a first delivery and a duplicate, so at-least-once
 * transport collapses into exactly-once logical notification. Any other status or a network
 * error is a delivery failure the dispatcher retries.
 */
export class HttpNotificationAdapter implements NotificationPort {
  private readonly endpoint: string | null;
  private readonly timeoutMs: number;

  constructor(options: HttpNotificationAdapterOptions) {
    const baseUrl = trimTrailingSlashes(options.baseUrl);
    // Fails fast on a malformed NOTIFICATION_PROVIDER_URL instead of at first delivery.
    // The migrate/seed processes legitimately run without a provider configured.
    this.endpoint =
      baseUrl.length === 0 ? null : new URL(`${baseUrl}/notifications`).toString();
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async send(message: NotificationMessage): Promise<void> {
    if (this.endpoint === null) {
      throw new Error(
        'NOTIFICATION_PROVIDER_URL is not configured; cannot deliver outbox notifications',
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': message.dedupeKey,
        },
        body: JSON.stringify({
          type: message.type,
          orderId: message.orderId,
          customerId: message.customerId,
          recipient: message.recipient,
          template: message.template,
          occurredAt: message.occurredAt.toISOString(),
          dedupeKey: message.dedupeKey,
          data: message.data,
        }),
        signal: controller.signal,
      });

      if (response.status !== 202) {
        const detail = await readBodySafely(response);
        throw new Error(
          `notification provider responded with ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
