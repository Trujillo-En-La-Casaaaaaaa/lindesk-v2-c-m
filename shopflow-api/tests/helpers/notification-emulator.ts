import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedNotification {
  readonly idempotencyKey: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Record<string, unknown>;
}

export interface NotificationEmulator {
  readonly baseUrl: string;
  /** Every HTTP request the API made, in order (including duplicate deliveries). */
  readonly received: ReceivedNotification[];
  /** Distinct idempotency keys: the number of logical notifications. */
  logicalCount(): number;
  readonly requestsToUnknownPath: string[];
  setMode(mode: 'accepted' | 'server-error'): void;
  close(): Promise<void>;
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed: unknown = raw.length === 0 ? {} : JSON.parse(raw);
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on('error', reject);
  });
}

/**
 * Deterministic local stand-in for the notification provider emulator owned by
 * shopflow-infra: accepts `POST /notifications`, answers `202` with `duplicate: true` when the
 * same idempotency key was seen before, and can be switched to fail with `500`.
 */
export async function startNotificationEmulator(): Promise<NotificationEmulator> {
  const received: ReceivedNotification[] = [];
  const requestsToUnknownPath: string[] = [];
  const seenKeys = new Set<string>();
  let mode: 'accepted' | 'server-error' = 'accepted';

  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/notifications') {
        requestsToUnknownPath.push(`${request.method ?? '?'} ${request.url ?? '?'}`);
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const body = await readJsonBody(request);
      const idempotencyKey = request.headers['idempotency-key'];
      const key = Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey;
      received.push({
        idempotencyKey: key,
        contentType: request.headers['content-type'],
        body,
      });

      if (mode === 'server-error') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'provider unavailable' }));
        return;
      }

      const duplicate = key !== undefined && seenKeys.has(key);
      if (key !== undefined) {
        seenKeys.add(key);
      }
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: key ?? '', status: 'accepted', duplicate }));
    })().catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'error' }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    received,
    requestsToUnknownPath,
    logicalCount: () => seenKeys.size,
    setMode: (next) => {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
