#!/usr/bin/env node
/**
 * ShopFlow black-box end-to-end verification.
 *
 * Runs inside the compose network (the `verify` service) and never touches host loopback:
 *   API_BASE_URL      default http://api:8080
 *   EMULATOR_BASE_URL default http://notification-emulator:4010
 *   VERIFY_PHASE      full | durability-prepare | durability-assert (default full)
 *   VERIFY_STATE_DIR  default /verify-state (bind-mounted state for the durability phases)
 *
 * Output contract:
 *   PASS <check-id> :: <description>
 *   FAIL <check-id> :: <description> :: <detail>
 *   SUMMARY checks=<n> passed=<n> failed=<n>
 * Exit code 0 only when failed == 0.
 *
 * The suite talks to the running system over HTTP only: no database access, no imports from
 * the API repository, no mocks. Notification assertions poll the emulator with a 10 second
 * timeout and a 100 ms interval.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// --- configuration -----------------------------------------------------------

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

const API_BASE_URL = stripTrailingSlashes(process.env.API_BASE_URL ?? 'http://api:8080');
const EMULATOR_BASE_URL = stripTrailingSlashes(
  process.env.EMULATOR_BASE_URL ?? 'http://notification-emulator:4010',
);
const VERIFY_PHASE = process.env.VERIFY_PHASE ?? 'full';
const VERIFY_STATE_DIR = process.env.VERIFY_STATE_DIR ?? '/verify-state';
const STATE_FILE = join(VERIFY_STATE_DIR, 'durability.json');

const API_TIMEOUT_MS = 15_000;
const NOTIFICATION_TIMEOUT_MS = 10_000;
const NOTIFICATION_POLL_INTERVAL_MS = 100;
const NOTIFICATION_SETTLE_MS = 750;
const MAX_DETAIL_BODY_CHARS = 300;

const DEMO_CUSTOMER_ID = 'customer-demo';
const ESPRESSO_PRODUCT_ID = 'prod-espresso-machine';
const GRINDER_PRODUCT_ID = 'prod-burr-grinder';

/** Frozen seed expectations (handoff/VERIFICATION_PLAN.md), already in name-ascending order. */
const EXPECTED_PRODUCTS = [
  {
    id: 'prod-burr-grinder',
    sku: 'SF-GRD-002',
    name: 'Burr Coffee Grinder',
    priceCents: 8999,
    availableQuantity: 10,
  },
  {
    id: 'prod-espresso-machine',
    sku: 'SF-ESP-001',
    name: 'Espresso Machine',
    priceCents: 24999,
    availableQuantity: 5,
  },
  {
    id: 'prod-milk-pitcher',
    sku: 'SF-MLK-003',
    name: 'Milk Pitcher',
    priceCents: 1999,
    availableQuantity: 25,
  },
  {
    id: 'prod-coffee-beans-1kg',
    sku: 'SF-BEA-004',
    name: 'Single Origin Coffee Beans 1 kg',
    priceCents: 3499,
    availableQuantity: 40,
  },
];

const EXPECTED_ORDER_TOTAL_CENTS = 2 * 24999 + 1 * 8999;

// --- result reporting --------------------------------------------------------

/** @type {{ id: string, ok: boolean }[]} */
const results = [];

function emit(id, description, ok, detail) {
  results.push({ id, ok });
  if (ok) {
    process.stdout.write(`PASS ${id} :: ${description}\n`);
    return;
  }
  process.stdout.write(`FAIL ${id} :: ${description} :: ${detail}\n`);
}

/**
 * Runs one check and reports its outcome.
 *
 * @param {string} id Stable check id used by the verification matrix.
 * @param {string | (() => string)} description Human readable description.
 * @param {() => Promise<void>} run Check body; throwing marks the check as failed.
 */
async function check(id, description, run) {
  const describe = () => {
    if (typeof description !== 'function') {
      return description;
    }
    try {
      return description();
    } catch {
      return id;
    }
  };
  try {
    await run();
    emit(id, describe(), true);
  } catch (error) {
    emit(id, describe(), false, error instanceof Error ? error.message : String(error));
  }
}

function summarize() {
  const failed = results.filter((result) => !result.ok).length;
  process.stdout.write(
    `SUMMARY checks=${results.length} passed=${results.length - failed} failed=${failed}\n`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

// --- generic helpers ---------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function truncateBody(text) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_DETAIL_BODY_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_DETAIL_BODY_CHARS)}... (${collapsed.length} chars)`;
}

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** Failure detail for an unexpected HTTP response: status code, error code, truncated body. */
function describeResponse(response, expected) {
  const errorField = response.json !== null && typeof response.json === 'object'
    ? response.json.error
    : undefined;
  const errorCode = errorField !== null && typeof errorField === 'object'
    ? errorField.code
    : errorField;
  return `expected=${expected} actual_status=${response.status} actual_code=${errorCode ?? 'n/a'} body=${truncateBody(response.text)}`;
}

// --- HTTP plumbing -----------------------------------------------------------

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} path
 * @param {{ body?: unknown, headers?: Record<string, string>, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, json: any, text: string }>}
 */
async function request(baseUrl, method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `${method} ${path} on ${baseUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

const apiGet = (path) => request(API_BASE_URL, 'GET', path);
const apiPost = (path, body) => request(API_BASE_URL, 'POST', path, { body });
const emulatorGet = (path) => request(EMULATOR_BASE_URL, 'GET', path);
const emulatorPost = (path, body) => request(EMULATOR_BASE_URL, 'POST', path, { body });

function assertStatus(response, expected, context) {
  if (response.status !== expected) {
    throw new Error(`${context}: ${describeResponse(response, `HTTP ${expected}`)}`);
  }
  return response;
}

function assertErrorResponse(response, { status, code, context, expected = '' }) {
  const actualCode = response.json?.error?.code;
  if (response.status !== status || actualCode !== code) {
    throw new Error(
      `${context}: ${describeResponse(response, `HTTP ${status} ${code}${expected ? ` ${expected}` : ''}`)}`,
    );
  }
  return response;
}

// --- system helpers ----------------------------------------------------------

async function readProducts() {
  const response = assertStatus(await apiGet('/api/products'), 200, 'GET /api/products');
  assertTrue(
    Array.isArray(response.json?.products),
    `GET /api/products: expected a products array: ${describeResponse(response, '{"products":[...]}')}`,
  );
  return response.json.products;
}

async function readProduct(productId) {
  const response = assertStatus(
    await apiGet(`/api/products/${productId}`),
    200,
    `GET /api/products/${productId}`,
  );
  assertTrue(
    response.json?.product !== undefined && response.json.product !== null,
    `GET /api/products/${productId}: expected a product object: ${describeResponse(response, '{"product":{...}}')}`,
  );
  return response.json.product;
}

const readEspressoQuantity = async () => (await readProduct(ESPRESSO_PRODUCT_ID)).availableQuantity;

const readGrinderQuantity = async () => (await readProduct(GRINDER_PRODUCT_ID)).availableQuantity;

async function readOrder(orderId) {
  const response = assertStatus(
    await apiGet(`/api/orders/${orderId}`),
    200,
    `GET /api/orders/${orderId}`,
  );
  assertTrue(
    response.json?.order !== undefined && response.json.order !== null,
    `GET /api/orders/${orderId}: expected an order object: ${describeResponse(response, '{"order":{...}}')}`,
  );
  return response.json.order;
}

async function readOrderCount() {
  const response = assertStatus(await apiGet('/api/orders?limit=200'), 200, 'GET /api/orders?limit=200');
  assertTrue(
    Array.isArray(response.json?.orders),
    `GET /api/orders?limit=200: expected an orders array: ${describeResponse(response, '{"orders":[...]}')}`,
  );
  return response.json.orders.length;
}

async function createOrder(items, customerId = DEMO_CUSTOMER_ID) {
  const response = assertStatus(
    await apiPost('/api/orders', { customerId, items }),
    201,
    `POST /api/orders ${JSON.stringify(items)}`,
  );
  assertTrue(
    response.json?.order !== undefined && response.json.order !== null,
    `POST /api/orders: expected an order object: ${describeResponse(response, '{"order":{...}}')}`,
  );
  return response.json.order;
}

async function listNotifications(query = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const suffix = search.toString();
  const path = `/notifications${suffix.length > 0 ? `?${suffix}` : ''}`;
  const response = assertStatus(await emulatorGet(path), 200, `GET ${path}`);
  assertTrue(
    Array.isArray(response.json?.notifications),
    `GET ${path}: expected a notifications array: ${describeResponse(response, '{"count":n,"notifications":[...]}')}`,
  );
  return response.json;
}

/**
 * Polls the emulator until `predicate` holds (10 s timeout, 100 ms interval).
 *
 * @param {{ type?: string, orderId?: string }} query
 * @param {(stored: { count: number, notifications: any[] }) => boolean} predicate
 * @param {string} description
 */
async function waitForNotifications(query, predicate, description) {
  const deadline = Date.now() + NOTIFICATION_TIMEOUT_MS;
  for (;;) {
    const stored = await listNotifications(query);
    if (predicate(stored)) {
      return stored;
    }
    if (Date.now() >= deadline) {
      const ids = stored.notifications.map((record) => record.id).join(', ');
      throw new Error(
        `${description}: timed out after ${NOTIFICATION_TIMEOUT_MS}ms polling GET /notifications (count=${stored.count} ids=[${ids}])`,
      );
    }
    await sleep(NOTIFICATION_POLL_INTERVAL_MS);
  }
}

/**
 * SLOT: records readings taken immediately before a step so later steps can assert the value
 * changed by exactly the expected amount.
 */
function createSlot() {
  const readings = new Map();
  return {
    async capture(name, read) {
      const value = await read();
      readings.set(name, value);
      return value;
    },
    read(name) {
      assertTrue(readings.has(name), `SLOT "${name}" was never captured by a preceding step`);
      return readings.get(name);
    },
  };
}

function requireOrder(order, checkId) {
  assertTrue(
    order !== null && order !== undefined,
    `the order is unavailable; see the "${checkId}" check for the underlying failure`,
  );
  return order;
}

/** Asserts a rejected cancellation attempt left the order untouched. */
async function assertOrderUnchanged(orderId, expectedStatus, context) {
  const order = await readOrder(orderId);
  assertTrue(
    order.status === expectedStatus,
    `${context}: expected status ${expectedStatus}, got ${order.status}`,
  );
  assertTrue(
    order.cancelledAt === null && order.cancellationReason === null,
    `${context}: expected null cancelledAt/cancellationReason, got ${JSON.stringify({ cancelledAt: order.cancelledAt, cancellationReason: order.cancellationReason })}`,
  );
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

// --- phase: full -------------------------------------------------------------

async function runFullPhase() {
  const slot = createSlot();
  /** @type {string[]} */
  const createdOrderIds = [];
  /** @type {Set<string>} */
  const cancelledOrderIds = new Set();
  let primaryOrder = null;
  let shippedOrder = null;
  let reasonOrder = null;
  let firstCancellation = null;
  let parallelOrder = null;

  await check(
    'emulator-reset',
    'the notification provider store is empty before the matrix runs',
    async () => {
      assertStatus(await emulatorPost('/notifications/reset'), 200, 'POST /notifications/reset');
      const health = assertStatus(await emulatorGet('/health'), 200, 'GET /health (emulator)');
      assertTrue(
        health.json?.count === 0,
        `emulator store is not empty after reset: GET /health (emulator) returned ${truncateBody(health.text)}`,
      );
    },
  );

  // --- health and catalog ----------------------------------------------------

  await check('health', 'GET /health reports status ok and database up', async () => {
    const response = assertStatus(await apiGet('/health'), 200, 'GET /health');
    assertTrue(
      response.json?.status === 'ok' && response.json?.database === 'up',
      `GET /health: ${describeResponse(response, '{"status":"ok","database":"up"}')}`,
    );
  });

  await check(
    'seed-products',
    'GET /api/products returns exactly the four frozen seed products in name-ascending order',
    async () => {
      const products = await readProducts();
      assertTrue(
        products.length === EXPECTED_PRODUCTS.length,
        `GET /api/products: expected exactly ${EXPECTED_PRODUCTS.length} products, got ${products.length}: ${JSON.stringify(products.map((product) => product.id))}`,
      );
      products.forEach((product, index) => {
        const expected = EXPECTED_PRODUCTS[index];
        const actual = {
          id: product.id,
          sku: product.sku,
          name: product.name,
          priceCents: product.priceCents,
          availableQuantity: product.availableQuantity,
        };
        assertTrue(
          actual.id === expected.id
            && actual.sku === expected.sku
            && actual.name === expected.name
            && actual.priceCents === expected.priceCents
            && actual.availableQuantity === expected.availableQuantity,
          `GET /api/products[${index}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      });
      const names = products.map((product) => product.name);
      const ascending = names.every((name, index) => index === 0 || names[index - 1].localeCompare(name) <= 0);
      assertTrue(ascending, `GET /api/products: products are not in name-ascending order: ${JSON.stringify(names)}`);
    },
  );

  await check(
    'product-detail',
    'GET /api/products/prod-espresso-machine returns the seeded product with quantity 5',
    async () => {
      const product = await readProduct(ESPRESSO_PRODUCT_ID);
      assertTrue(
        product.id === ESPRESSO_PRODUCT_ID
          && product.sku === 'SF-ESP-001'
          && product.priceCents === 24999
          && product.availableQuantity === 5,
        `GET /api/products/${ESPRESSO_PRODUCT_ID}: unexpected product ${JSON.stringify({ id: product.id, sku: product.sku, priceCents: product.priceCents, availableQuantity: product.availableQuantity })}`,
      );
    },
  );

  // --- inventory validation before order creation ---------------------------

  await check(
    'inventory-reject',
    'an order for 999 espresso machines is rejected with 409 INSUFFICIENT_INVENTORY and details',
    async () => {
      await slot.capture('espressoBeforeReject', readEspressoQuantity);
      await slot.capture('orderCountBeforeReject', readOrderCount);
      const response = assertErrorResponse(
        await apiPost('/api/orders', {
          customerId: DEMO_CUSTOMER_ID,
          items: [{ productId: ESPRESSO_PRODUCT_ID, quantity: 999 }],
        }),
        {
          status: 409,
          code: 'INSUFFICIENT_INVENTORY',
          context: 'POST /api/orders quantity=999',
        },
      );
      const details = response.json.error.details ?? {};
      assertTrue(
        details.productId === ESPRESSO_PRODUCT_ID
          && details.requested === 999
          && details.available === 5,
        `POST /api/orders quantity=999: ${describeResponse(response, `details={"productId":"${ESPRESSO_PRODUCT_ID}","requested":999,"available":5}`)}`,
      );
    },
  );

  await check(
    'inventory-unchanged',
    'the rejected order left both inventory and the order list untouched',
    async () => {
      const espresso = await readEspressoQuantity();
      const orderCount = await readOrderCount();
      assertTrue(
        espresso === slot.read('espressoBeforeReject'),
        `espresso quantity changed from ${slot.read('espressoBeforeReject')} to ${espresso} after the rejected request`,
      );
      assertTrue(
        orderCount === slot.read('orderCountBeforeReject'),
        `order count changed from ${slot.read('orderCountBeforeReject')} to ${orderCount} after the rejected request`,
      );
    },
  );

  await check(
    'product-missing',
    'an order referencing an unknown product is rejected with 404 PRODUCT_NOT_FOUND and no side effect',
    async () => {
      const espressoBefore = await readEspressoQuantity();
      assertErrorResponse(
        await apiPost('/api/orders', {
          customerId: DEMO_CUSTOMER_ID,
          items: [{ productId: 'prod-does-not-exist', quantity: 1 }],
        }),
        {
          status: 404,
          code: 'PRODUCT_NOT_FOUND',
          context: 'POST /api/orders with prod-does-not-exist',
        },
      );
      const espressoAfter = await readEspressoQuantity();
      assertTrue(
        espressoAfter === espressoBefore,
        `inventory changed from ${espressoBefore} to ${espressoAfter} after the unknown-product request`,
      );
    },
  );

  await check(
    'validation-empty-items',
    'an order with an empty items array is rejected with 400 VALIDATION_ERROR',
    async () => {
      assertErrorResponse(
        await apiPost('/api/orders', { customerId: DEMO_CUSTOMER_ID, items: [] }),
        { status: 400, code: 'VALIDATION_ERROR', context: 'POST /api/orders items=[]' },
      );
    },
  );

  await check(
    'validation-limit',
    'a non-numeric order list limit is rejected with 400 VALIDATION_ERROR',
    async () => {
      assertErrorResponse(await apiGet('/api/orders?limit=abc'), {
        status: 400,
        code: 'VALIDATION_ERROR',
        context: 'GET /api/orders?limit=abc',
      });
    },
  );

  // --- order creation, decrement, notification ------------------------------

  await check(
    'order-create',
    'POST /api/orders creates a CONFIRMED order with 2 espresso machines and 1 grinder',
    async () => {
      await slot.capture('espressoBeforeCreate', readEspressoQuantity);
      await slot.capture('grinderBeforeCreate', readGrinderQuantity);
      const order = await createOrder([
        { productId: ESPRESSO_PRODUCT_ID, quantity: 2 },
        { productId: GRINDER_PRODUCT_ID, quantity: 1 },
      ]);
      primaryOrder = order;
      createdOrderIds.push(order.id);
      assertTrue(
        typeof order.id === 'string' && order.id.length > 0,
        `POST /api/orders: expected a non-empty order id, got ${JSON.stringify(order.id)}`,
      );
      assertTrue(
        order.status === 'CONFIRMED',
        `POST /api/orders: expected status CONFIRMED, got ${JSON.stringify(order.status)}`,
      );
      assertTrue(
        order.totalCents === EXPECTED_ORDER_TOTAL_CENTS,
        `POST /api/orders: expected totalCents ${EXPECTED_ORDER_TOTAL_CENTS}, got ${JSON.stringify(order.totalCents)}`,
      );
      assertTrue(
        order.currency === 'USD',
        `POST /api/orders: expected currency USD, got ${JSON.stringify(order.currency)}`,
      );
      assertTrue(
        Array.isArray(order.items) && order.items.length === 2,
        `POST /api/orders: expected two items, got ${JSON.stringify(order.items)}`,
      );
      assertTrue(
        order.shippedAt === null && order.cancelledAt === null && order.cancellationReason === null,
        `POST /api/orders: expected null shippedAt/cancelledAt/cancellationReason, got ${JSON.stringify({ shippedAt: order.shippedAt, cancelledAt: order.cancelledAt, cancellationReason: order.cancellationReason })}`,
      );
    },
  );

  await check(
    'inventory-decrement',
    'inventory was decremented by exactly the ordered quantities',
    async () => {
      const espresso = await readEspressoQuantity();
      const grinder = await readGrinderQuantity();
      const expectedEspresso = slot.read('espressoBeforeCreate') - 2;
      const expectedGrinder = slot.read('grinderBeforeCreate') - 1;
      assertTrue(
        espresso === expectedEspresso,
        `espresso: expected ${expectedEspresso} after ordering 2 (seed value ${slot.read('espressoBeforeCreate')}), got ${espresso}`,
      );
      assertTrue(
        grinder === expectedGrinder,
        `grinder: expected ${expectedGrinder} after ordering 1 (seed value ${slot.read('grinderBeforeCreate')}), got ${grinder}`,
      );
      assertTrue(
        espresso === 3 && grinder === 9,
        `expected espresso=3 and grinder=9 from the frozen seed, got espresso=${espresso} grinder=${grinder}`,
      );
    },
  );

  await check(
    'confirm-notification',
    'exactly one ORDER_CONFIRMED notification is delivered for the created order',
    async () => {
      const order = requireOrder(primaryOrder, 'order-create');
      const stored = await waitForNotifications(
        { type: 'ORDER_CONFIRMED', orderId: order.id },
        (state) => state.count === 1,
        `ORDER_CONFIRMED for ${order.id}`,
      );
      const record = stored.notifications[0];
      assertTrue(
        record.id === `order:${order.id}:confirmed`
          && record.type === 'ORDER_CONFIRMED'
          && record.orderId === order.id,
        `ORDER_CONFIRMED for ${order.id}: unexpected record ${JSON.stringify(record)}`,
      );
    },
  );

  await check(
    'order-detail',
    'GET /api/orders/<id> returns the same status, items and totals as creation',
    async () => {
      const order = requireOrder(primaryOrder, 'order-create');
      const fetched = await readOrder(order.id);
      assertTrue(
        fetched.id === order.id && fetched.status === order.status && fetched.totalCents === order.totalCents,
        `order detail differs from creation: ${JSON.stringify({ id: fetched.id, status: fetched.status, totalCents: fetched.totalCents })}`,
      );
      assertTrue(
        JSON.stringify(fetched.items) === JSON.stringify(order.items),
        `order items differ from creation: expected ${JSON.stringify(order.items)}, got ${JSON.stringify(fetched.items)}`,
      );
    },
  );

  // --- administrative actions ----------------------------------------------

  await check(
    'ship-action',
    'POST /ship moves the order to SHIPPED and sets shippedAt',
    async () => {
      const order = requireOrder(primaryOrder, 'order-create');
      const response = assertStatus(
        await apiPost(`/api/orders/${order.id}/ship`),
        200,
        `POST /api/orders/${order.id}/ship`,
      );
      shippedOrder = response.json?.order ?? null;
      requireOrder(shippedOrder, 'ship-action');
      assertTrue(
        shippedOrder.status === 'SHIPPED',
        `POST /ship: expected status SHIPPED, got ${JSON.stringify(shippedOrder.status)}`,
      );
      assertTrue(
        isIsoTimestamp(shippedOrder.shippedAt),
        `POST /ship: expected a non-null ISO-8601 shippedAt, got ${JSON.stringify(shippedOrder.shippedAt)}`,
      );
    },
  );

  await check('ship-idempotent', 'a second POST /ship returns 200 with the same shippedAt', async () => {
    const order = requireOrder(primaryOrder, 'order-create');
    const first = requireOrder(shippedOrder, 'ship-action');
    const response = assertStatus(
      await apiPost(`/api/orders/${order.id}/ship`),
      200,
      `second POST /api/orders/${order.id}/ship`,
    );
    const again = response.json?.order ?? null;
    assertTrue(
      again !== null && again.status === 'SHIPPED' && again.shippedAt === first.shippedAt,
      `second POST /ship: expected status SHIPPED and shippedAt ${JSON.stringify(first.shippedAt)}, got ${JSON.stringify({ status: again?.status, shippedAt: again?.shippedAt })}`,
    );
  });

  await check(
    'cancel-shipped-rejected',
    'cancelling a SHIPPED order is rejected with 409 and changes nothing',
    async () => {
      const order = requireOrder(primaryOrder, 'order-create');
      const espressoBefore = await readEspressoQuantity();
      assertErrorResponse(await apiPost(`/api/orders/${order.id}/cancel`, { reason: 'too late' }), {
        status: 409,
        code: 'ORDER_ALREADY_SHIPPED',
        context: `POST /api/orders/${order.id}/cancel on a SHIPPED order`,
      });
      const fetched = await readOrder(order.id);
      assertTrue(
        fetched.status === 'SHIPPED' && fetched.cancelledAt === null,
        `after the rejected cancellation: expected status SHIPPED and cancelledAt null, got ${JSON.stringify({ status: fetched.status, cancelledAt: fetched.cancelledAt })}`,
      );
      const espressoAfter = await readEspressoQuantity();
      assertTrue(
        espressoAfter === espressoBefore,
        `inventory changed from ${espressoBefore} to ${espressoAfter} after the rejected cancellation`,
      );
    },
  );

  // --- cancellation reason validation --------------------------------------

  await check(
    'reason-empty',
    'an empty cancellation reason is rejected with 400 INVALID_CANCELLATION_REASON',
    async () => {
      const order = await createOrder([{ productId: ESPRESSO_PRODUCT_ID, quantity: 1 }]);
      reasonOrder = order;
      createdOrderIds.push(order.id);
      await slot.capture('espressoBeforeCancelAttempts', readEspressoQuantity);
      assertErrorResponse(await apiPost(`/api/orders/${order.id}/cancel`, { reason: '' }), {
        status: 400,
        code: 'INVALID_CANCELLATION_REASON',
        context: `POST /api/orders/${order.id}/cancel reason=""`,
      });
      await assertOrderUnchanged(order.id, 'CONFIRMED', 'after reason=""');
      const espresso = await readEspressoQuantity();
      assertTrue(
        espresso === slot.read('espressoBeforeCancelAttempts'),
        `inventory changed from ${slot.read('espressoBeforeCancelAttempts')} to ${espresso} after the rejected cancellation`,
      );
    },
  );

  await check(
    'reason-blank',
    'a whitespace-only cancellation reason is rejected with 400 INVALID_CANCELLATION_REASON',
    async () => {
      const order = requireOrder(reasonOrder, 'reason-empty');
      assertErrorResponse(await apiPost(`/api/orders/${order.id}/cancel`, { reason: '   ' }), {
        status: 400,
        code: 'INVALID_CANCELLATION_REASON',
        context: `POST /api/orders/${order.id}/cancel reason="   "`,
      });
      await assertOrderUnchanged(order.id, 'CONFIRMED', 'after reason="   "');
      const espresso = await readEspressoQuantity();
      assertTrue(
        espresso === slot.read('espressoBeforeCancelAttempts'),
        `inventory changed from ${slot.read('espressoBeforeCancelAttempts')} to ${espresso} after the rejected cancellation`,
      );
    },
  );

  await check(
    'reason-too-long',
    'a 201-character cancellation reason is rejected with 400 INVALID_CANCELLATION_REASON',
    async () => {
      const order = requireOrder(reasonOrder, 'reason-empty');
      const reason = 'x'.repeat(201);
      assertErrorResponse(await apiPost(`/api/orders/${order.id}/cancel`, { reason }), {
        status: 400,
        code: 'INVALID_CANCELLATION_REASON',
        context: `POST /api/orders/${order.id}/cancel with a 201-character reason`,
      });
      await assertOrderUnchanged(order.id, 'CONFIRMED', 'after a 201-character reason');
      const espresso = await readEspressoQuantity();
      assertTrue(
        espresso === slot.read('espressoBeforeCancelAttempts'),
        `inventory changed from ${slot.read('espressoBeforeCancelAttempts')} to ${espresso} after the rejected cancellation`,
      );
    },
  );

  // --- successful cancellation ---------------------------------------------

  await check(
    'cancel-success',
    'a 200-character cancellation reason cancels the order and is stored verbatim',
    async () => {
      const order = requireOrder(reasonOrder, 'reason-empty');
      const reason = 'x'.repeat(200);
      const response = assertStatus(
        await apiPost(`/api/orders/${order.id}/cancel`, { reason }),
        200,
        `POST /api/orders/${order.id}/cancel with a 200-character reason`,
      );
      firstCancellation = response.json?.order ?? null;
      assertTrue(
        firstCancellation !== null,
        `POST /cancel: expected an order in the response, got ${truncateBody(response.text)}`,
      );
      cancelledOrderIds.add(order.id);
      assertTrue(
        firstCancellation.status === 'CANCELLED',
        `POST /cancel: expected status CANCELLED, got ${JSON.stringify(firstCancellation.status)}`,
      );
      assertTrue(
        isIsoTimestamp(firstCancellation.cancelledAt),
        `POST /cancel: expected a non-null ISO-8601 cancelledAt, got ${JSON.stringify(firstCancellation.cancelledAt)}`,
      );
      assertTrue(
        firstCancellation.cancellationReason === reason,
        `POST /cancel: expected the submitted 200-character reason to be stored verbatim, got ${JSON.stringify({ length: typeof firstCancellation.cancellationReason === 'string' ? firstCancellation.cancellationReason.length : null, value: firstCancellation.cancellationReason })}`,
      );
    },
  );

  await check(
    'cancel-restores-inventory',
    'cancelling the order restored its quantity exactly once',
    async () => {
      const espresso = await readEspressoQuantity();
      const expected = slot.read('espressoBeforeCancelAttempts') + 1;
      assertTrue(
        espresso === expected,
        `espresso: expected ${expected} (the cancelled order ordered 1 and is restored exactly once), got ${espresso}`,
      );
      await slot.capture('espressoAfterRestore', readEspressoQuantity);
    },
  );

  await check(
    'cancel-notification',
    'exactly one ORDER_CANCELLED notification is delivered for the cancelled order',
    async () => {
      const order = requireOrder(reasonOrder, 'reason-empty');
      const stored = await waitForNotifications(
        { type: 'ORDER_CANCELLED', orderId: order.id },
        (state) => state.count === 1,
        `ORDER_CANCELLED for ${order.id}`,
      );
      const record = stored.notifications[0];
      assertTrue(
        record.id === `order:${order.id}:cancelled` && record.type === 'ORDER_CANCELLED',
        `ORDER_CANCELLED for ${order.id}: unexpected record ${JSON.stringify(record)}`,
      );
    },
  );

  await check(
    'cancel-repeat-safe',
    'repeating the cancellation keeps the first result, restores no inventory and sends no second notification',
    async () => {
      const order = requireOrder(reasonOrder, 'reason-empty');
      const first = requireOrder(firstCancellation, 'cancel-success');
      const response = assertStatus(
        await apiPost(`/api/orders/${order.id}/cancel`, { reason: 'a different reason' }),
        200,
        `repeated POST /api/orders/${order.id}/cancel`,
      );
      const repeated = response.json?.order ?? null;
      assertTrue(
        repeated !== null && repeated.status === 'CANCELLED',
        `repeated POST /cancel: expected status CANCELLED, got ${JSON.stringify({ status: repeated?.status })}`,
      );
      assertTrue(
        repeated.cancelledAt === first.cancelledAt,
        `repeated POST /cancel: cancelledAt changed from ${JSON.stringify(first.cancelledAt)} to ${JSON.stringify(repeated.cancelledAt)}`,
      );
      assertTrue(
        repeated.cancellationReason === first.cancellationReason,
        `repeated POST /cancel: cancellationReason changed from ${JSON.stringify(first.cancellationReason)} to ${JSON.stringify(repeated.cancellationReason)}`,
      );
      const espresso = await readEspressoQuantity();
      assertTrue(
        espresso === slot.read('espressoAfterRestore'),
        `inventory changed from ${slot.read('espressoAfterRestore')} to ${espresso} after the repeated cancellation`,
      );
      await sleep(NOTIFICATION_SETTLE_MS);
      const stored = await listNotifications({ type: 'ORDER_CANCELLED', orderId: order.id });
      assertTrue(
        stored.count === 1,
        `ORDER_CANCELLED for ${order.id}: expected exactly one notification, got ${stored.count} (${JSON.stringify(stored.notifications.map((record) => record.id))})`,
      );
    },
  );

  await check(
    'cancel-parallel-safe',
    'two concurrent cancellations both succeed, agree on the result and restore inventory and notification exactly once',
    async () => {
      const order = await createOrder([{ productId: ESPRESSO_PRODUCT_ID, quantity: 1 }]);
      parallelOrder = order;
      createdOrderIds.push(order.id);
      await slot.capture('espressoAfterParallelCreate', readEspressoQuantity);
      const [firstResponse, secondResponse] = await Promise.all([
        apiPost(`/api/orders/${order.id}/cancel`, { reason: 'parallel cancellation a' }),
        apiPost(`/api/orders/${order.id}/cancel`, { reason: 'parallel cancellation b' }),
      ]);
      assertStatus(firstResponse, 200, `parallel POST /api/orders/${order.id}/cancel #1`);
      assertStatus(secondResponse, 200, `parallel POST /api/orders/${order.id}/cancel #2`);
      const first = firstResponse.json?.order ?? null;
      const second = secondResponse.json?.order ?? null;
      assertTrue(
        first !== null && second !== null && first.status === 'CANCELLED' && second.status === 'CANCELLED',
        `parallel cancellations: expected both responses to be CANCELLED, got ${JSON.stringify({ first: first?.status, second: second?.status })}`,
      );
      assertTrue(
        first.cancelledAt === second.cancelledAt,
        `parallel cancellations disagree on cancelledAt: ${JSON.stringify(first.cancelledAt)} vs ${JSON.stringify(second.cancelledAt)}`,
      );
      assertTrue(
        first.cancellationReason === second.cancellationReason,
        `parallel cancellations disagree on cancellationReason: ${JSON.stringify(first.cancellationReason)} vs ${JSON.stringify(second.cancellationReason)}`,
      );
      cancelledOrderIds.add(order.id);
      const expected = slot.read('espressoAfterParallelCreate') + 1;
      const espresso = await readEspressoQuantity();
      assertTrue(
        espresso === expected,
        `inventory restored more than once: expected ${expected} (ordered 1, restored once), got ${espresso}`,
      );
      await sleep(NOTIFICATION_SETTLE_MS);
      const stored = await listNotifications({ type: 'ORDER_CANCELLED', orderId: order.id });
      assertTrue(
        stored.count === 1,
        `ORDER_CANCELLED for ${order.id}: expected exactly one notification, got ${stored.count} (${JSON.stringify(stored.notifications.map((record) => record.id))})`,
      );
    },
  );

  await check(
    'ship-cancelled-rejected',
    'shipping a CANCELLED order is rejected with 409 and leaves it CANCELLED',
    async () => {
      const order = requireOrder(parallelOrder ?? reasonOrder, 'cancel-parallel-safe');
      assertErrorResponse(await apiPost(`/api/orders/${order.id}/ship`), {
        status: 409,
        code: 'ORDER_ALREADY_CANCELLED',
        context: `POST /api/orders/${order.id}/ship on a CANCELLED order`,
      });
      const fetched = await readOrder(order.id);
      assertTrue(
        fetched.status === 'CANCELLED',
        `after the rejected shipment: expected status CANCELLED, got ${JSON.stringify(fetched.status)}`,
      );
    },
  );

  // --- unknown resources ----------------------------------------------------

  await check(
    'order-missing',
    'GET /api/orders/does-not-exist returns 404 ORDER_NOT_FOUND',
    async () => {
      assertErrorResponse(await apiGet('/api/orders/does-not-exist'), {
        status: 404,
        code: 'ORDER_NOT_FOUND',
        context: 'GET /api/orders/does-not-exist',
      });
    },
  );

  await check('route-missing', 'GET /api/nope returns 404 NOT_FOUND', async () => {
    assertErrorResponse(await apiGet('/api/nope'), {
      status: 404,
      code: 'NOT_FOUND',
      context: 'GET /api/nope',
    });
  });

  // --- offline determinism --------------------------------------------------

  await check(
    'emulator-offline-safe',
    'the emulator holds exactly the expected confirmations and cancellations and nothing else',
    async () => {
      const expectedConfirmed = createdOrderIds.length;
      const expectedCancelled = cancelledOrderIds.size;
      const expectedTotal = expectedConfirmed + expectedCancelled;
      const stored = await waitForNotifications(
        {},
        (state) => state.count === expectedTotal,
        `expected exactly ${expectedTotal} notifications (${expectedConfirmed} confirmations + ${expectedCancelled} cancellations)`,
      );
      const confirmed = await listNotifications({ type: 'ORDER_CONFIRMED' });
      assertTrue(
        confirmed.count === expectedConfirmed,
        `ORDER_CONFIRMED count: expected ${expectedConfirmed}, got ${confirmed.count}`,
      );
      const cancelled = await listNotifications({ type: 'ORDER_CANCELLED' });
      assertTrue(
        cancelled.count === expectedCancelled,
        `ORDER_CANCELLED count: expected ${expectedCancelled}, got ${cancelled.count}`,
      );
      const stray = stored.notifications.filter((record) => !createdOrderIds.includes(record.orderId));
      assertTrue(
        stray.length === 0,
        `unexpected notifications for orders this phase never created: ${JSON.stringify(stray)}`,
      );
      const malformed = stored.notifications.filter(
        (record) => record.id !== `order:${record.orderId}:${record.type === 'ORDER_CONFIRMED' ? 'confirmed' : 'cancelled'}`,
      );
      assertTrue(
        malformed.length === 0,
        `notifications whose id does not echo the order dedupe key: ${JSON.stringify(malformed)}`,
      );
    },
  );
}

// --- phase: durability-prepare ----------------------------------------------

async function runDurabilityPrepare() {
  /** @type {{ orderId: string, espressoBefore: number, espressoAfter: number, totalCents: number, createdAt: string } | null} */
  let snapshot = null;

  await check(
    'durability-prepare-reset',
    'the notification provider store is empty before the durability sequence',
    async () => {
      assertStatus(await emulatorPost('/notifications/reset'), 200, 'POST /notifications/reset');
      const health = assertStatus(await emulatorGet('/health'), 200, 'GET /health (emulator)');
      assertTrue(
        health.json?.count === 0,
        `emulator store is not empty after reset: GET /health (emulator) returned ${truncateBody(health.text)}`,
      );
    },
  );

  await check(
    'durability-prepare-order',
    () => (snapshot === null
      ? `the order and the snapshot in ${STATE_FILE} could not be prepared`
      : `order ${snapshot.orderId} created, espresso ${snapshot.espressoBefore} -> ${snapshot.espressoAfter}, totalCents ${snapshot.totalCents}, snapshot written to ${STATE_FILE}`),
    async () => {
      const espressoBefore = await readEspressoQuantity();
      const order = await createOrder(
        [{ productId: ESPRESSO_PRODUCT_ID, quantity: 1 }],
        'customer-durability',
      );
      const espressoAfter = await readEspressoQuantity();
      assertTrue(
        espressoAfter === espressoBefore - 1,
        `espresso: expected ${espressoBefore - 1} after creating the order, got ${espressoAfter}`,
      );
      snapshot = {
        orderId: order.id,
        espressoBefore,
        espressoAfter,
        totalCents: order.totalCents,
        createdAt: order.createdAt,
      };
      await mkdir(VERIFY_STATE_DIR, { recursive: true });
      await writeFile(STATE_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      // Deliberately does not wait for the notification: delivery has to survive the
      // `docker compose restart api` that follows this phase.
    },
  );
}

// --- phase: durability-assert ----------------------------------------------

async function runDurabilityAssert() {
  /** @type {{ orderId: string, espressoBefore: number, espressoAfter: number, totalCents: number, createdAt: string } | null} */
  let snapshot = null;

  await check(
    'durability-state',
    `the durability snapshot written to ${STATE_FILE} before the restart is readable`,
    async () => {
      const raw = await readFile(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      assertTrue(
        typeof parsed.orderId === 'string' && parsed.orderId.length > 0,
        `snapshot has no orderId: ${truncateBody(raw)}`,
      );
      assertTrue(
        Number.isInteger(parsed.espressoBefore) && Number.isInteger(parsed.espressoAfter),
        `snapshot has no integer espresso readings: ${truncateBody(raw)}`,
      );
      assertTrue(
        Number.isInteger(parsed.totalCents),
        `snapshot has no integer totalCents: ${truncateBody(raw)}`,
      );
      snapshot = parsed;
    },
  );

  if (snapshot === null) {
    const detail = `the durability snapshot at ${STATE_FILE} is unavailable; run VERIFY_PHASE=durability-prepare and restart the api service before VERIFY_PHASE=durability-assert`;
    emit('durability-order-integrity', 'the order survived the api restart unchanged', false, detail);
    emit('durability-inventory-single-decrement', 'inventory was decremented exactly once across the restart', false, detail);
    emit('durability-notification-exactly-once', 'exactly one ORDER_CONFIRMED notification was delivered after the restart', false, detail);
    return;
  }

  const prepared = snapshot;

  await check(
    'durability-order-integrity',
    `order ${prepared.orderId} survived the api restart as CONFIRMED with the same total and items`,
    async () => {
      const response = assertStatus(
        await apiGet(`/api/orders/${prepared.orderId}`),
        200,
        `GET /api/orders/${prepared.orderId} after the restart`,
      );
      const order = response.json?.order ?? null;
      assertTrue(order !== null, `GET /api/orders/${prepared.orderId}: expected an order object: ${describeResponse(response, '{"order":{...}}')}`);
      assertTrue(
        order.status === 'CONFIRMED',
        `after the restart: expected status CONFIRMED, got ${JSON.stringify(order.status)}`,
      );
      assertTrue(
        order.totalCents === prepared.totalCents,
        `after the restart: expected totalCents ${prepared.totalCents}, got ${JSON.stringify(order.totalCents)}`,
      );
      assertTrue(
        Array.isArray(order.items)
          && order.items.length === 1
          && order.items[0].productId === ESPRESSO_PRODUCT_ID
          && order.items[0].quantity === 1,
        `after the restart: unexpected items ${JSON.stringify(order.items)}`,
      );
    },
  );

  await check(
    'durability-inventory-single-decrement',
    `espresso inventory stays at ${prepared.espressoAfter}, so the decrement happened exactly once`,
    async () => {
      const quantity = await readEspressoQuantity();
      assertTrue(
        quantity === prepared.espressoAfter,
        `espresso after the restart: expected ${prepared.espressoAfter} (decrement of 1 applied exactly once, seed value ${prepared.espressoBefore}), got ${quantity}`,
      );
    },
  );

  await check(
    'durability-notification-exactly-once',
    `exactly one ORDER_CONFIRMED notification was delivered for ${prepared.orderId} across the restart`,
    async () => {
      const stored = await waitForNotifications(
        { type: 'ORDER_CONFIRMED', orderId: prepared.orderId },
        (state) => state.count === 1,
        `ORDER_CONFIRMED for ${prepared.orderId} after the restart`,
      );
      const record = stored.notifications[0];
      assertTrue(
        record.id === `order:${prepared.orderId}:confirmed` && record.type === 'ORDER_CONFIRMED',
        `ORDER_CONFIRMED for ${prepared.orderId}: unexpected record ${JSON.stringify(record)}`,
      );
    },
  );
}

// --- entrypoint --------------------------------------------------------------

async function main() {
  switch (VERIFY_PHASE) {
    case 'full':
      await runFullPhase();
      break;
    case 'durability-prepare':
      await runDurabilityPrepare();
      break;
    case 'durability-assert':
      await runDurabilityAssert();
      break;
    default:
      emit(
        'verify-phase',
        'VERIFY_PHASE selects full | durability-prepare | durability-assert',
        false,
        `unknown VERIFY_PHASE ${JSON.stringify(VERIFY_PHASE)}`,
      );
      break;
  }
  summarize();
}

main().catch((error) => {
  emit(
    'verify-runner',
    'the verification runner completed without an unexpected failure',
    false,
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
  summarize();
});
