export type NotificationType = 'ORDER_CONFIRMED' | 'ORDER_CANCELLED';

/**
 * One notification request, as sent to the provider (`POST /notifications`).
 * Recorded verbatim in `notification_outbox.payload` and replayed by the dispatcher.
 */
export interface NotificationMessage {
  readonly type: NotificationType;
  readonly orderId: string;
  readonly customerId: string;
  readonly recipient: string;
  readonly template: 'order-confirmed' | 'order-cancelled';
  readonly occurredAt: Date;
  readonly dedupeKey: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Outbound port for the external notification provider. Implemented over HTTP in
 * adapters/outbound/notification; use cases never call it (they only record outbox intent).
 */
export interface NotificationPort {
  send(message: NotificationMessage): Promise<void>;
}
