/**
 * Deterministic local notification-provider emulator.
 *
 * Dependency-free Node.js service built on `node:http` that stands in for the external
 * `notification-provider` node of the ShopFlow plan. It is reached by the API over the
 * compose network at `http://notification-emulator:4010`.
 *
 * Determinism rules (see handoff/NOTIFICATION_PROVIDER_CONTRACT.md):
 * - no outbound network calls, ever;
 * - no randomness: identifiers echo the request's `Idempotency-Key`;
 * - responses are a pure function of the ordered sequence of received requests;
 * - the only time-derived field is `receivedAt`;
 * - state lives in memory only, so a restart equals `POST /notifications/reset`.
 *
 * Contract summary:
 *   GET  /health                  -> 200 {"status":"ok","provider":"notification-emulator","count":n}
 *   POST /notifications           -> 202 {"id":key,"status":"accepted","duplicate":bool}
 *   GET  /notifications           -> 200 {"count":n,"notifications":[...]} (?type=&orderId=)
 *   POST /notifications/reset     -> 200 {"reset":true,"removed":n}
 *   anything else                 -> 404 {"error":"not_found"}
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createNotificationStore } from './store.mjs';

export const PROVIDER_NAME = 'notification-emulator';
export const DEFAULT_PORT = 4010;

/** Frozen notification types of the provider contract. */
const ALLOWED_TYPES = new Set(['ORDER_CONFIRMED', 'ORDER_CANCELLED']);

/** Bodies larger than this are rejected; notifications are tiny by design. */
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Reads the raw request body, bounded by `MAX_BODY_BYTES`.
 *
 * @returns {Promise<{ text: string, tooLarge: boolean }>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge });
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const { text, tooLarge } = await readBody(req);
  if (tooLarge) {
    return { ok: false, error: 'payload_too_large' };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Body of `POST /notifications`. */
async function handleCreateNotification(store, now, req, res) {
  const rawKey = req.headers['idempotency-key'];
  const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    sendJson(res, 400, { error: 'missing_idempotency_key' });
    return;
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    sendJson(res, parsed.error === 'payload_too_large' ? 413 : 400, { error: parsed.error });
    return;
  }

  const body = parsed.value;
  const type = isPlainObject(body) ? body.type : undefined;
  if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
    sendJson(res, 400, { error: 'invalid_type' });
    return;
  }

  const orderId = isPlainObject(body) ? body.orderId : undefined;
  if (typeof orderId !== 'string' || orderId.trim().length === 0) {
    sendJson(res, 400, { error: 'invalid_order_id' });
    return;
  }

  const dedupeKey = isPlainObject(body) ? body.dedupeKey : undefined;
  const dedupeKeyMatches = typeof dedupeKey === 'string'
    && dedupeKey.trim().length > 0
    && dedupeKey === idempotencyKey;
  if (!dedupeKeyMatches) {
    sendJson(res, 400, { error: 'dedupe_key_mismatch' });
    return;
  }

  const customerId = isPlainObject(body) && typeof body.customerId === 'string'
    ? body.customerId
    : null;

  const { duplicate } = store.record(
    { id: idempotencyKey, type, orderId, customerId },
    now,
  );

  sendJson(res, 202, { id: idempotencyKey, status: 'accepted', duplicate });
}

/** Optional `type` / `orderId` filters; unknown filter keys are ignored. */
function readNotificationFilters(url) {
  const read = (name) => {
    const value = url.searchParams.get(name);
    return value === null || value === '' ? undefined : value;
  };
  return { type: read('type'), orderId: read('orderId') };
}

async function route(store, now, req, res) {
  const url = new URL(req.url ?? '/', 'http://provider.local');
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { status: 'ok', provider: PROVIDER_NAME, count: store.count });
    return;
  }

  if (method === 'POST' && pathname === '/notifications') {
    await handleCreateNotification(store, now, req, res);
    return;
  }

  if (method === 'GET' && pathname === '/notifications') {
    const notifications = store.list(readNotificationFilters(url));
    sendJson(res, 200, { count: notifications.length, notifications });
    return;
  }

  if (method === 'POST' && pathname === '/notifications/reset') {
    sendJson(res, 200, { reset: true, removed: store.reset() });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

/**
 * Builds the emulator without listening.
 *
 * @param {{ now?: () => string }} [options]
 * @returns {{ server: import('node:http').Server, store: ReturnType<typeof createNotificationStore> }}
 */
export function createEmulatorServer(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const store = createNotificationStore();
  const server = createServer((req, res) => {
    route(store, now, req, res).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'request failed', detail })}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error' });
        return;
      }
      res.destroy();
    });
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n');
    }
  });
  return { server, store };
}

/**
 * Builds the emulator and starts listening.
 *
 * @param {{ port?: number, host?: string, now?: () => string }} [options]
 * @returns {Promise<{ server: import('node:http').Server, store: ReturnType<typeof createNotificationStore>, port: number, baseUrl: string }>}
 */
export function startEmulator(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '0.0.0.0';
  const { server, store } = createEmulatorServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ server, store, port: boundPort, baseUrl: `http://127.0.0.1:${boundPort}` });
    });
  });
}

/** `true` when this module is the process entrypoint (`node src/server.mjs`). */
function isEntrypoint() {
  const entry = process.argv[1];
  return typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  startEmulator({ port })
    .then(({ server, port: boundPort }) => {
      process.stdout.write(
        `${JSON.stringify({ level: 'info', msg: 'notification-emulator listening', port: boundPort })}\n`,
      );
      const shutdown = (signal) => {
        process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'shutting down', signal })}\n`);
        server.close(() => {
          process.exit(0);
        });
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', msg: 'failed to start', detail: error instanceof Error ? error.message : String(error) })}\n`,
      );
      process.exit(1);
    });
}
