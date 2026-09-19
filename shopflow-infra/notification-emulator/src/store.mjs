/**
 * Deduplicating in-memory notification store for the provider emulator.
 *
 * The store is the whole persistence layer of the emulator: nothing leaves the
 * process, nothing is written to disk. Restarting the process therefore has the
 * same observable effect as `POST /notifications/reset`.
 *
 * Deduplication is by `Idempotency-Key` (which the API sends as the `dedupeKey` of
 * the notification it wants delivered): the first time a key is seen a record is
 * appended, every later delivery of the same key is reported as a duplicate and
 * appends nothing. That is what turns the API's at-least-once transport retries
 * into exactly-once logical notification.
 */

/**
 * @typedef {object} StoredNotification
 * @property {number} sequence Insertion order, starting at 1.
 * @property {string} id The `Idempotency-Key` of the first delivery.
 * @property {string} type `ORDER_CONFIRMED` or `ORDER_CANCELLED`.
 * @property {string} orderId Order the notification belongs to.
 * @property {string|null} customerId Customer the notification belongs to.
 * @property {string} receivedAt ISO-8601 timestamp of the first delivery.
 */

/**
 * @typedef {object} NotificationInput
 * @property {string} id Idempotency key of this delivery.
 * @property {string} type Notification type.
 * @property {string} orderId Order id.
 * @property {string|null} customerId Customer id.
 */

export function createNotificationStore() {
  /** @type {StoredNotification[]} */
  const records = [];
  /** @type {Set<string>} */
  const seenKeys = new Set();

  function list(filters = {}) {
    const type = filters.type;
    const orderId = filters.orderId;
    return records
      .filter((record) => (type === undefined || record.type === type)
        && (orderId === undefined || record.orderId === orderId))
      .map((record) => ({ ...record }));
  }

  return {
    /** Number of stored notifications. */
    get count() {
      return records.length;
    },

    /** `true` when the idempotency key was already delivered. */
    has(id) {
      return seenKeys.has(id);
    },

    /**
     * Appends the notification unless its idempotency key was already seen.
     *
     * @param {NotificationInput} input
     * @param {() => string} now Injected clock so the timestamp stays the only time-derived field.
     * @returns {{ duplicate: boolean, record: StoredNotification | null }}
     */
    record(input, now) {
      if (seenKeys.has(input.id)) {
        return { duplicate: true, record: null };
      }
      seenKeys.add(input.id);
      /** @type {StoredNotification} */
      const record = {
        sequence: records.length + 1,
        id: input.id,
        type: input.type,
        orderId: input.orderId,
        customerId: input.customerId,
        receivedAt: now(),
      };
      records.push(record);
      return { duplicate: false, record: { ...record } };
    },

    /**
     * Stored notifications in insertion order, optionally filtered by `type` and/or
     * `orderId` (applied together when both are present).
     *
     * @param {{ type?: string, orderId?: string }} [filters]
     * @returns {StoredNotification[]}
     */
    list,

    /**
     * Empties the store.
     *
     * @returns {number} Number of removed notifications.
     */
    reset() {
      const removed = records.length;
      records.length = 0;
      seenKeys.clear();
      return removed;
    },
  };
}
