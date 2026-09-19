import type { NotificationMessage, NotificationPort } from '../../src/application/ports/outbound/notification.port';

/**
 * Notification port double for unit tests: records every message and can be told to fail a
 * number of times (or always).
 */
export class RecordingNotificationPort implements NotificationPort {
  readonly messages: NotificationMessage[] = [];
  private failuresRemaining: number;
  private readonly failureMessage: string;

  constructor(options: { failuresRemaining?: number; failureMessage?: string } = {}) {
    this.failuresRemaining = options.failuresRemaining ?? 0;
    this.failureMessage = options.failureMessage ?? 'notification provider unavailable';
  }

  failAlways(): void {
    this.failuresRemaining = Number.POSITIVE_INFINITY;
  }

  send(message: NotificationMessage): Promise<void> {
    this.messages.push(message);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error(this.failureMessage));
    }
    return Promise.resolve();
  }
}
