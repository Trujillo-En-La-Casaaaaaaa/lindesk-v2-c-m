# ShopFlow API

Backend service for the ShopFlow demo system: product catalog, product inventory, order creation
with inventory validation and decrement, order detail/status, administrative `SHIPPED` action,
order-confirmation notifications, and customer cancellation with the exact cancellation rules.

TypeScript + Node.js on a **hexagonal (ports and adapters)** structure. The service owns the single
write path to PostgreSQL: schema, migrations, and deterministic seed data. The HTTP contract is
frozen and consumed by `shopflow-web` and by the `shopflow-infra` verification suite.

---

## 1. Architecture

```
src/
  domain/                     # entities, invariants, stable error codes — framework free
    model/product.ts          # Product, Inventory, ProductView
    model/order.ts            # Order, OrderItem, OrderStatus, totals, shipment policy
    model/cancellation.ts     # cancellation reason rule + cancellation policy
    errors.ts                 # DomainError subclasses with the frozen error codes
  application/
    ports/inbound/*.ts        # CreateOrder, GetOrder, ListOrders, ListProducts, CancelOrder, ShipOrder
    ports/outbound/*.ts       # repositories, UnitOfWork, NotificationPort, Clock, IdGenerator, Logger
    use-cases/*.ts            # one file per use case + DispatchNotifications
  adapters/
    inbound/http/             # Express app factory, routes, request validation, error mapping
    outbound/persistence/postgres/   # repositories, unit of work, migrator, seeder
    outbound/notification/    # HTTP implementation of NotificationPort
    outbound/system/          # clock, uuid id generator, console logger
  composition/                # env parsing (config.ts) and the only adapter wiring (container.ts)
  main/                       # process entrypoints: server, migrate, seed
migrations/001_init.sql       # canonical schema (identical to handoff/SCHEMA.sql)
tests/{unit,integration,contract,architecture,helpers}
```

### Dependency rule (enforced by `tests/architecture`)

| Layer | May import | Must not import |
| --- | --- | --- |
| `domain` | nothing outside `domain` | `application`, `adapters`, `composition`, `express`, `pg` |
| `application` | `domain`, own ports | `adapters`, `composition`, `express`, `pg` |
| `adapters` | `domain`, `application/ports` | `composition`, other adapters |
| `composition` | everything (it is the only place that constructs adapters) | – |
| `main` | `composition` only | `adapters` |

`tests/architecture/inward-dependencies.spec.ts` scans every `src/**/*.ts` import specifier and fails
on any violation, and `tests/architecture/source-hygiene.spec.ts` fails on `TODO`/`FIXME`/placeholder
markers, commented-out code, or `any` escape hatches in `domain`/`application`.

### Transactional design

- All writes go through `UnitOfWork.run(...)`, which opens a transaction on a dedicated pooled
  connection, hands the callback transaction-bound repositories, and commits or rolls back.
- Order creation: `BEGIN` → lock inventory rows `... FOR UPDATE ORDER BY product_id` → validate
  availability (unknown product → `404`, insufficient → `409`, nothing written) → insert order and
  items → decrement inventory → insert exactly one `ORDER_CONFIRMED` outbox row → `COMMIT`.
- Cancellation: `BEGIN` → `SELECT ... FROM orders WHERE id = $1 FOR UPDATE` → state machine →
  set status/`cancelled_at`/`cancellation_reason` → restore inventory once → insert exactly one
  `ORDER_CANCELLED` outbox row → `COMMIT`.
- Shipping: `BEGIN` → lock order row → state machine → set `SHIPPED`/`shipped_at` → `COMMIT`.
- The only concurrency mechanisms are the row locks and the `UNIQUE` constraint on
  `notification_outbox.dedupe_key` — no distributed transaction, no broker, no second datastore.
- Order status, timestamps, cancellation reason, inventory change, and outbox intent therefore change
  together or not at all. No HTTP call ever happens inside a transaction.
- Order items are returned in ascending `product_id` order so responses are deterministic.

### Notification delivery

1. Use cases never call HTTP: they record durable intent (`notification_outbox`, status `PENDING`).
2. `DispatchNotifications` polls every `OUTBOX_POLL_INTERVAL_MS` (default 250 ms), claims up to 50
   `PENDING` rows ordered by `created_at`, and sends each through `NotificationPort`.
3. Success → `SENT` + `sent_at`, `last_error` cleared. Failure → `attempts + 1`, `last_error` stored,
   row stays retryable; at `OUTBOX_MAX_ATTEMPTS` (default 10) the row becomes `FAILED` and is logged.
4. The HTTP adapter `POST`s to `${NOTIFICATION_PROVIDER_URL}/notifications` with
   `Idempotency-Key: <dedupe_key>`; the provider collapses duplicates, so at-least-once transport
   yields exactly-once logical notification.
5. The dispatcher starts with the server and stops on `SIGTERM`/`SIGINT`: stop polling, finish the
   in-flight batch, close the HTTP server, close the pool.

### Migrations and seed

- `npm run migrate` applies `migrations/*.sql` in lexicographic order inside one transaction guarded
  by `pg_advisory_xact_lock`, recording each id in `schema_migrations` (`001_init` for the canonical
  schema). It is idempotent and safe to run concurrently; a second run reports
  `applied: [], skipped: ['001_init']`.
- `npm run seed` upserts the fixed dataset from `handoff/SEED_DATA.md`
  (`INSERT ... ON CONFLICT (id) DO UPDATE`), resets `inventory.available_quantity` to the documented
  baseline, never creates orders, and prints exactly one stdout line:
  `seed: products=4 inventory=4`.
- The server verifies the schema at startup; if migrations are missing it applies them before
  listening (idempotent, so it is safe alongside the `shopflow-infra` migration job).

---

## 2. Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | no | `8080` | HTTP listen port |
| `DATABASE_URL` | **yes** | – | PostgreSQL connection string (`postgres://user:pass@host:5432/db`) |
| `NOTIFICATION_PROVIDER_URL` | **yes** for the API process | – | Base URL of the notification provider (`migrate`/`seed` do not need it) |
| `CORS_ORIGIN` | no | `http://localhost:3000` | Allowed browser origin for `shopflow-web` |
| `OUTBOX_POLL_INTERVAL_MS` | no | `250` | Outbox dispatcher poll interval |
| `OUTBOX_MAX_ATTEMPTS` | no | `10` | Attempts before an outbox row is marked `FAILED` |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `MIGRATIONS_DIR` | no | `<repo>/migrations` | Override the migrations directory |

`.env.example` documents local-only example values; no secret is stored in this repository.
Logs are single-line JSON (`debug`/`info` on stdout, `warn`/`error` on stderr).

---

## 3. Commands

```bash
npm ci                       # install from the committed package-lock.json
npm run typecheck            # tsc --noEmit (src + tests)
npm run build                # emit dist/
npm run migrate              # apply migrations (idempotent)
npm run seed                 # load deterministic seed data (idempotent)
npm start                    # run the API (dist/main/server.js)

npm run test:unit            # domain + use cases with in-memory fakes (no database)
npm run test:architecture     # inward-dependency + source-hygiene guards
docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration     # real PostgreSQL 16 (port 55432)
npm run test:contract        # HTTP contract over real PostgreSQL 16
docker compose -f docker-compose.test.yml down -v
```

`docker-compose.test.yml` is test-only and is **not** the system entrypoint; runtime orchestration
belongs to `shopflow-infra`.

Docker image: multi-stage `node:20-alpine`, `npm ci` → `npm run build` → production-only
`node_modules`, non-root `node` user, `CMD ["node","dist/main/server.js"]`.

---

## 4. Frozen HTTP contract

JSON everywhere; timestamps are ISO-8601 UTC; money is integer minor units plus a `currency`.

| Method | Path | Success | Failures |
| --- | --- | --- | --- |
| `GET` | `/health` | `200 {"status":"ok","database":"up"}` | `503 {"status":"degraded","database":"down"}` |
| `GET` | `/api/products` | `200 {"products":[ProductView,…]}` (name asc, then id asc) | – |
| `GET` | `/api/products/:id` | `200 {"product":ProductView}` | `404 PRODUCT_NOT_FOUND` |
| `POST` | `/api/orders` | `201 {"order":OrderView}` | `400 VALIDATION_ERROR`, `404 PRODUCT_NOT_FOUND`, `409 INSUFFICIENT_INVENTORY` |
| `GET` | `/api/orders?limit=n` | `200 {"orders":[OrderView,…]}` (newest first, default 50, max 200) | `400 VALIDATION_ERROR` |
| `GET` | `/api/orders/:id` | `200 {"order":OrderView}` | `404 ORDER_NOT_FOUND` |
| `POST` | `/api/orders/:id/cancel` | `200 {"order":OrderView}` (`CANCELLED`, reason stored) | `400 INVALID_CANCELLATION_REASON`, `404 ORDER_NOT_FOUND`, `409 ORDER_ALREADY_SHIPPED` |
| `POST` | `/api/orders/:id/ship` | `200 {"order":OrderView}` (`SHIPPED`) | `404 ORDER_NOT_FOUND`, `409 ORDER_ALREADY_CANCELLED` |

Error envelope for every non-2xx response (also `404 NOT_FOUND` for unknown routes):

```json
{ "error": { "code": "ERROR_CODE", "message": "Human readable message", "details": {} } }
```

```json
// ProductView
{ "id": "prod-espresso-machine", "sku": "SF-ESP-001", "name": "Espresso Machine",
  "description": "…", "priceCents": 24999, "currency": "USD", "availableQuantity": 5 }

// OrderView
{ "id": "…", "customerId": "customer-demo", "status": "CONFIRMED", "totalCents": 24999,
  "currency": "USD", "createdAt": "2026-09-19T10:15:30.000Z", "updatedAt": "…",
  "shippedAt": null, "cancelledAt": null, "cancellationReason": null,
  "items": [ { "productId": "…", "productName": "…", "quantity": 1,
               "unitPriceCents": 24999, "lineTotalCents": 24999 } ] }
```

Behaviour locks:

- `POST /api/orders` validates `customerId` (non-empty), `items` (non-empty), integer `quantity >= 1`,
  and rejects duplicate `productId` entries — every failure writes nothing.
- `POST /api/orders/:id/cancel` requires a reason that is non-empty after trimming and at most 200
  characters (the same rule the DB `CHECK` enforces). Repeating a cancellation returns `200` with the
  **original** `cancelledAt`/`cancellationReason`, restores no inventory, and creates no notification.
- Cancelling a `SHIPPED` order → `409`; shipping a `CANCELLED` order → `409`; both write nothing.
- Unexpected failures become `500 INTERNAL_ERROR` with a generic message; SQL text, driver errors, and
  stack traces are logged server-side only. An oversized body is rejected as `400 VALIDATION_ERROR`.

Outbound notification call (consumed by the `notification-provider` emulator):

```
POST {NOTIFICATION_PROVIDER_URL}/notifications
Content-Type: application/json
Idempotency-Key: {dedupe_key}

{ "type": "ORDER_CONFIRMED", "orderId": "…", "customerId": "…",
  "recipient": "customer:customer-demo", "template": "order-confirmed",
  "occurredAt": "2026-09-19T10:15:31.000Z", "dedupeKey": "order:…:confirmed",
  "data": { "status": "CONFIRMED", "totalCents": 24999, "currency": "USD" } }
```

Cancellations use `type` `ORDER_CANCELLED`, `template` `order-cancelled`,
`dedupeKey` `order:{orderId}:cancelled`, and `data` additionally carries `cancellationReason`.
Only `202` counts as delivered.

---

## 5. Database schema

`migrations/001_init.sql` (verbatim `handoff/SCHEMA.sql`) creates `schema_migrations`, `products`,
`inventory`, `orders`, `order_items`, and `notification_outbox`, including the constraints that make
`shipped_at` present exactly when the status is `SHIPPED`, `cancelled_at` + `cancellation_reason`
present exactly when the status is `CANCELLED` (reason length 1..200), `available_quantity >= 0`,
`quantity > 0`, and `notification_outbox.dedupe_key` unique.

Seed products (also asserted by `shopflow-infra`):

| id | sku | price_cents | available_quantity |
| --- | --- | --- | --- |
| `prod-espresso-machine` | `SF-ESP-001` | 24999 | 5 |
| `prod-burr-grinder` | `SF-GRD-002` | 8999 | 10 |
| `prod-milk-pitcher` | `SF-MLK-003` | 1999 | 25 |
| `prod-coffee-beans-1kg` | `SF-BEA-004` | 3499 | 40 |

---

## 6. Test suites

| Suite | Command | What it proves |
| --- | --- | --- |
| Unit | `npm run test:unit` | domain rules (reason `''`/`'   '`/201 rejected, 200 accepted), totals, state machines; use cases with snapshot-rollback fakes: insufficient inventory rejects with no side effects, success produces one decrement and one `ORDER_CONFIRMED` intent, cancellation of a `SHIPPED` order is rejected, repeated cancellation is a no-op, dispatcher retry/`FAILED` budget and 50-row batch limit |
| Architecture | `npm run test:architecture` | inward dependency rule, no adapter-to-adapter imports, no `TODO`/placeholder/commented-out code, no `any` in domain/application |
| Integration | `npm run test:integration` | real PostgreSQL 16: atomic decrement, rollback on failure, cancellation fields + single inventory restore, **two (and eight) concurrent cancellations restore inventory exactly once and produce exactly one `ORDER_CANCELLED` row**, concurrent creation cannot oversell or deadlock, `dedupe_key` uniqueness, idempotent/concurrent `npm run migrate`, idempotent `npm run seed`, dispatcher retry → `FAILED`, at-least-once redelivery collapsing to one logical notification, service startup/`/health`/clean shutdown |
| Contract | `npm run test:contract` | every documented endpoint, payload shape, status code, and error code over real PostgreSQL 16, plus CORS preflight, unknown-route `404`, and the `500` envelope |

Note: the OS-level `SIGTERM` test is restricted to POSIX platforms (`it.skipIf`), because Windows
terminates a process on `SIGTERM`/`SIGINT` without running Node signal handlers. The identical shutdown
sequence (dispatcher stop → HTTP close → pool close → exit 0) is exercised on every platform by the
in-process lifecycle test, which starts the service against the real database, serves `/health`, drains
the outbox through the dispatcher, and then verifies the closed socket and pool.
