/**
 * Contract tests for the notification provider emulator (`node --test`, no test dependencies).
 *
 * Every test starts its own instance on an ephemeral port and closes it again, so the suite
 * leaves no dangling handles and no shared state between cases.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEmulator } from '../src/server.mjs';

/** @param {import('node:http').Server} server */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Runs `run` against a freshly started emulator on an ephemeral port.
 *
 * @param {(context: { baseUrl: string }) => Promise<void>} run
 */
async function withEmulator(run) {
  const { server, baseUrl } = await startEmulator({ port: 0 });
  try {
    await run({ baseUrl });
  } finally {
    await closeServer(server);
  }
}

/** A valid `ORDER_CONFIRMED` payload; `overrides` replaces or removes fields. */
function notificationBody(overrides = {}) {
  const orderId = overrides.orderId ?? 'order-demo-1';
  return {
    type: 'ORDER_CONFIRMED',
    orderId,
    customerId: 'customer-demo',
    recipient: 'customer:customer-demo',
    template: 'order-confirmed',
    occurredAt: '2026-09-19T10:15:31.000Z',
    dedupeKey: `order:${orderId}:confirmed`,
    data: { status: 'CONFIRMED', totalCents: 24999, currency: 'USD' },
    ...overrides,
  };
}

/**
 * POSTs a notification body.
 *
 * @param {string} baseUrl
 * @param {unknown} body
 * @param {{ key?: string, rawBody?: string }} [options]
 */
async function postNotification(baseUrl, body, options = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (options.key !== undefined) {
    headers['Idempotency-Key'] = options.key;
  }
  const rawBody = options.rawBody !== undefined ? options.rawBody : JSON.stringify(body);
  if (options.rawBody === undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}/notifications`, { method: 'POST', headers, body: rawBody });
  return { status: response.status, body: await response.json() };
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

test('GET /health returns 200 with count 0 on a fresh instance', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const response = await getJson(baseUrl, '/health');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: 'ok', provider: 'notification-emulator', count: 0 });
  });
});

test('a valid ORDER_CONFIRMED notification is accepted and stored exactly once', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const key = 'order:order-demo-1:confirmed';
    const accepted = await postNotification(baseUrl, notificationBody(), { key });

    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.body, { id: key, status: 'accepted', duplicate: false });

    const stored = await getJson(baseUrl, '/notifications');
    assert.equal(stored.status, 200);
    assert.equal(stored.body.count, 1);
    assert.equal(stored.body.notifications.length, 1);

    const [record] = stored.body.notifications;
    assert.equal(record.sequence, 1);
    assert.equal(record.id, key);
    assert.equal(record.type, 'ORDER_CONFIRMED');
    assert.equal(record.orderId, 'order-demo-1');
    assert.equal(record.customerId, 'customer-demo');
    assert.ok(Number.isFinite(Date.parse(record.receivedAt)), 'receivedAt must be an ISO-8601 timestamp');
    assert.equal(record.receivedAt, new Date(record.receivedAt).toISOString());
  });
});

test('repeating the same Idempotency-Key is reported as duplicate and appends nothing', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const key = 'order:order-demo-1:confirmed';
    const first = await postNotification(baseUrl, notificationBody(), { key });
    const second = await postNotification(baseUrl, notificationBody(), { key });

    assert.equal(first.body.duplicate, false);
    assert.equal(second.status, 202);
    assert.deepEqual(second.body, { id: key, status: 'accepted', duplicate: true });

    const stored = await getJson(baseUrl, '/notifications');
    assert.equal(stored.body.count, 1, 'a duplicate delivery must not append a second record');
  });
});

test('a different Idempotency-Key for the same order stores a separate record', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const orderId = 'order-demo-1';
    const firstKey = `order:${orderId}:confirmed`;
    const secondKey = `order:${orderId}:confirmed:retry-2`;

    await postNotification(baseUrl, notificationBody({ orderId }), { key: firstKey });
    const second = await postNotification(
      baseUrl,
      notificationBody({ orderId, dedupeKey: secondKey }),
      { key: secondKey },
    );

    assert.equal(second.body.duplicate, false);
    const stored = await getJson(baseUrl, `/notifications?orderId=${orderId}`);
    assert.equal(stored.body.count, 2);
    assert.deepEqual(
      stored.body.notifications.map((record) => [record.sequence, record.id]),
      [[1, firstKey], [2, secondKey]],
    );
  });
});

test('a missing or empty Idempotency-Key is rejected with 400', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const missing = await postNotification(baseUrl, notificationBody());
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { error: 'missing_idempotency_key' });

    const empty = await postNotification(baseUrl, notificationBody(), { key: '' });
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.body, { error: 'missing_idempotency_key' });

    const stored = await getJson(baseUrl, '/notifications');
    assert.equal(stored.body.count, 0, 'a rejected request must store nothing');
  });
});

test('an invalid type is rejected with 400', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const response = await postNotification(baseUrl, notificationBody({ type: 'ORDER_PAID' }), {
      key: 'order:order-demo-1:confirmed',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'invalid_type' });
    assert.equal((await getJson(baseUrl, '/notifications')).body.count, 0);
  });
});

test('a missing orderId is rejected with 400', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const body = { ...notificationBody() };
    delete body.orderId;
    const response = await postNotification(baseUrl, body, { key: 'order:order-demo-1:confirmed' });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'invalid_order_id' });
    assert.equal((await getJson(baseUrl, '/notifications')).body.count, 0);
  });
});

test('a dedupeKey that differs from the Idempotency-Key is rejected with 400', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const response = await postNotification(
      baseUrl,
      notificationBody({ dedupeKey: 'order:order-demo-1:something-else' }),
      { key: 'order:order-demo-1:confirmed' },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'dedupe_key_mismatch' });
    assert.equal((await getJson(baseUrl, '/notifications')).body.count, 0);
  });
});

test('a body that is not valid JSON is rejected with 400', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const response = await postNotification(baseUrl, undefined, {
      key: 'order:order-demo-1:confirmed',
      rawBody: '{"type":"ORDER_CONFIRMED",',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'invalid_json' });
    assert.equal((await getJson(baseUrl, '/notifications')).body.count, 0);
  });
});

test('GET /notifications filters by type and orderId and ignores unknown filters', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const confirmedKey = 'order:order-a:confirmed';
    const cancelledKey = 'order:order-a:cancelled';
    const otherOrderKey = 'order:order-b:confirmed';

    await postNotification(baseUrl, notificationBody({ orderId: 'order-a' }), { key: confirmedKey });
    await postNotification(
      baseUrl,
      notificationBody({ orderId: 'order-a', type: 'ORDER_CANCELLED', dedupeKey: cancelledKey }),
      { key: cancelledKey },
    );
    await postNotification(baseUrl, notificationBody({ orderId: 'order-b' }), { key: otherOrderKey });

    const all = await getJson(baseUrl, '/notifications');
    assert.equal(all.body.count, 3);
    assert.deepEqual(all.body.notifications.map((record) => record.sequence), [1, 2, 3]);

    const cancelled = await getJson(baseUrl, '/notifications?type=ORDER_CANCELLED');
    assert.equal(cancelled.body.count, 1);
    assert.equal(cancelled.body.notifications[0].id, cancelledKey);

    const bothFilters = await getJson(baseUrl, '/notifications?type=ORDER_CONFIRMED&orderId=order-a');
    assert.equal(bothFilters.body.count, 1);
    assert.equal(bothFilters.body.notifications[0].id, confirmedKey);

    const ignoredFilter = await getJson(baseUrl, '/notifications?limit=1');
    assert.equal(ignoredFilter.body.count, 3);
  });
});

test('POST /notifications/reset clears the store and reports the removed count', async () => {
  await withEmulator(async ({ baseUrl }) => {
    await postNotification(baseUrl, notificationBody({ orderId: 'order-a' }), {
      key: 'order:order-a:confirmed',
    });
    await postNotification(
      baseUrl,
      notificationBody({ orderId: 'order-a', type: 'ORDER_CANCELLED', dedupeKey: 'order:order-a:cancelled' }),
      { key: 'order:order-a:cancelled' },
    );

    const response = await fetch(`${baseUrl}/notifications/reset`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reset: true, removed: 2 });

    const stored = await getJson(baseUrl, '/notifications');
    assert.equal(stored.body.count, 0);

    const health = await getJson(baseUrl, '/health');
    assert.equal(health.body.count, 0);
  });
});

test('an unknown route or method returns 404', async () => {
  await withEmulator(async ({ baseUrl }) => {
    const unknownRoute = await getJson(baseUrl, '/nope');
    assert.equal(unknownRoute.status, 404);
    assert.deepEqual(unknownRoute.body, { error: 'not_found' });

    const unknownMethod = await fetch(`${baseUrl}/health`, { method: 'POST' });
    assert.equal(unknownMethod.status, 404);
    assert.deepEqual(await unknownMethod.json(), { error: 'not_found' });

    const unknownNested = await getJson(baseUrl, '/notifications/unknown');
    assert.equal(unknownNested.status, 404);
    assert.deepEqual(unknownNested.body, { error: 'not_found' });
  });
});
