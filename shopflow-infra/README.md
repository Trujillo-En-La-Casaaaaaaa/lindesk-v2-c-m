# ShopFlow — local runtime and end-to-end verification

`shopflow-infra` is the **integration owner** of the ShopFlow local stack. It owns runtime
configuration, the deterministic notification-provider emulator, deterministic bring-up, and the
black-box verification suite. It owns **no domain logic**: the schema, the HTTP API, and the seed
data belong to `shopflow-api`, and the presentation tier belongs to `shopflow-web`. This repository
builds their images, orders their startup, and proves the whole system works.

```
postgres (healthy) -> migrate (exit 0) -> seed (exit 0) -> api (healthy) -> web (started)
                                     \-> notification-emulator (healthy) -^
```

Verification status for this checkout: the emulator contract suite passes with zero failures and zero
skips (`npm ci && npm test`), `docker compose up -d --wait` brings up `postgres`,
`notification-emulator`, `migrate`, `seed`, and `api` (healthy / `Exited (0)`) from a clean volume,
`VERIFY_PHASE=full` reports 28/28 black-box checks, and the restart-durability sequence
(`durability-prepare` → `docker compose restart api` → `durability-assert`) reports 4/4. The `web`
service could not be exercised here because `../shopflow-web` is not implemented in this checkout —
its build context contains only the handoff, so `docker compose build` fails for `web` alone. That is
the only unavailable check; see §11, which also documents how the `postgres` configuration file is
delivered on hosts whose Docker Desktop file sharing cannot expose that host path to a non-root
container user (the file content is identical either way).

---

## 1. Prerequisites

| Requirement | Why |
| --- | --- |
| Docker Engine with **Docker Compose v2.17.0+** (the `docker compose` command) | `depends_on.condition: service_completed_successfully` and `up --wait` |
| Sibling checkouts `../shopflow-api` and `../shopflow-web` | `shopflow-infra` builds both images; it contains neither application |
| Node.js 20+ (host only) | run the emulator unit tests without Docker (`npm ci && npm test`) |

The three repositories must be checked out as siblings under one parent directory:

```
<parent>/
  shopflow-api/
  shopflow-web/
  shopflow-infra/     <- run docker compose from here
```

Override the build contexts with `API_BUILD_CONTEXT` / `WEB_BUILD_CONTEXT` if your layout differs.

## 2. Quick start

```bash
cp .env.example .env          # optional: the defaults already match the contracts
docker compose up -d --build --wait
docker compose ps
```

`up -d --build --wait` returns only when `postgres`, `notification-emulator` and `api` are
**healthy** and the one-shot `migrate` and `seed` services have **exited 0**. The seed job is
deterministic, so a fresh volume always yields the same four products.

| Endpoint | URL |
| --- | --- |
| Web application | <http://localhost:3000> |
| API | <http://localhost:8080> (`GET /health`) |
| Notification emulator | <http://localhost:4010> (`GET /health`) |
| PostgreSQL | `localhost:5432` (user/password/database from `.env.example`) |

The web bundle is built with `VITE_API_BASE_URL` baked in (default `http://localhost:8080`), so it
calls the API directly from the browser; the API allows exactly that origin through `CORS_ORIGIN`.

## 3. Full command sequence

```bash
# 1. emulator contract tests (no Docker needed)
npm ci --prefix notification-emulator
npm test --prefix notification-emulator

# 2. build and start the stack
docker compose build
docker compose up -d --wait
docker compose ps

# 3. black-box functional matrix against the freshly seeded system
docker compose --profile verify run --rm -e VERIFY_PHASE=full verify

# 4. restart-durability sequence
docker compose --profile verify run --rm -e VERIFY_PHASE=durability-prepare verify
docker compose restart api
docker compose --profile verify run --rm -e VERIFY_PHASE=durability-assert verify

# 5. stop everything and drop the database volume
docker compose down -v
```

## 4. Services

Service names, ports, environment variables, and dependency conditions are a frozen contract:
`shopflow-api`, `shopflow-web`, and the verification suite consume them.

| Service | Image | Published port | Health check | Depends on |
| --- | --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | `${POSTGRES_HOST_PORT:-5432}` → 5432 | `pg_isready -U $POSTGRES_USER -d $POSTGRES_DB`, 5 s interval, 20 retries, 10 s start period | – |
| `notification-emulator` | built from `./notification-emulator` | `${EMULATOR_HOST_PORT:-4010}` → 4010 | `fetch('http://127.0.0.1:4010/health')`, 5 s interval, 20 retries, 5 s start period | – |
| `migrate` (one-shot) | `shopflow-api:local` | – | exits 0 | `postgres` healthy |
| `seed` (one-shot) | `shopflow-api:local` | – | exits 0 | `migrate` completed successfully |
| `api` | `shopflow-api:local` | `${API_HOST_PORT:-8080}` → 8080 | `fetch('http://127.0.0.1:8080/health')`, 5 s interval, 30 retries, 10 s start period | `postgres` healthy, `notification-emulator` healthy, `seed` completed successfully |
| `web` | `shopflow-web:local` | `${WEB_HOST_PORT:-3000}` → 80 | – | `api` healthy |
| `verify` (profile `verify`) | `node:20-alpine` | – | – | `api` healthy, `notification-emulator` healthy, `web` started |

* `postgres` runs `postgres -c config_file=/etc/shopflow/postgresql.conf`, so the repository's
  `postgres/postgresql.conf` is the effective server configuration (`listen_addresses = '*'`,
  `timezone = 'UTC'`, bounded memory/connection/timeout values, UTC logging). Authentication stays at
  the image default, so `pg_isready` and password authentication keep working.
* `migrate` runs `node dist/main/migrate.js` and `seed` runs `node dist/main/seed.js` **from the API
  image**. This repository never contains schema DDL or seed rows.
* `api` receives `DATABASE_URL`, `NOTIFICATION_PROVIDER_URL=http://notification-emulator:4010`,
  `CORS_ORIGIN`, `OUTBOX_POLL_INTERVAL_MS=250`, and `LOG_LEVEL`; all service-to-service traffic uses
  compose service names on the default network, never host loopback.
* `verify` is never part of the default `up`; it only runs with `--profile verify`.

## 5. Environment variables

Every variable and its local-only default is documented in `.env.example`. Nothing outside that file
contains credentials.

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_BUILD_CONTEXT` | `../shopflow-api` | Build context of the API image (migrate/seed/api share it) |
| `WEB_BUILD_CONTEXT` | `../shopflow-web` | Build context of the web image |
| `WEB_API_BASE_URL` | `http://localhost:8080` | Value injected as `VITE_API_BASE_URL` into the web bundle |
| `POSTGRES_USER` | `shopflow` | Database user |
| `POSTGRES_PASSWORD` | `shopflow_local_dev_only` | Database password (local only) |
| `POSTGRES_DB` | `shopflow` | Database name |
| `POSTGRES_HOST_PORT` | `5432` | Published PostgreSQL port |
| `API_HOST_PORT` | `8080` | Published API port |
| `WEB_HOST_PORT` | `3000` | Published web port |
| `EMULATOR_HOST_PORT` | `4010` | Published emulator port |
| `CORS_ORIGIN` | `http://localhost:3000` | Browser origin allowed by the API |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | API outbox dispatcher poll interval |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

Only the documented host ports are published, and no service beyond the list above exists.

## 6. Health-check semantics and startup ordering

Docker Compose starts services in the order implied by `depends_on`, and `--wait` makes `up` block
until the outcome is known:

1. `postgres` becomes **healthy** when `pg_isready` succeeds against the configured database.
2. `notification-emulator` becomes **healthy** when its `/health` endpoint answers `200`.
3. `migrate` runs once and must **exit 0**; a non-zero exit aborts the whole `up`.
4. `seed` runs once after `migrate` and must **exit 0**; it re-applies the fixed dataset and restores
   the documented inventory baseline.
5. `api` starts only after `seed` completed, and becomes **healthy** when `/health` reports
   `{"status":"ok","database":"up"}`. The notification emulator must already be healthy because the
   outbox dispatcher starts sending as soon as orders exist.
6. `web` starts after the API is healthy.

Inspect the outcome with `docker compose ps -a` (a healthy `postgres`, `notification-emulator`, and
`api`, and `migrate`/`seed` as `Exited (0)`).

## 7. Notification provider emulator

`notification-emulator/` is a dependency-free Node.js 20 service built on `node:http` that stands in
for the external notification provider. It runs as the non-root `node` user, has an empty runtime
dependency set (the committed `package-lock.json` is used by `npm ci` in the image build), and is
reached by the API at `http://notification-emulator:4010`.

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/health` | `200 {"status":"ok","provider":"notification-emulator","count":n}` |
| `POST` | `/notifications` | `202 {"id":<Idempotency-Key>,"status":"accepted","duplicate":<bool>}` |
| `GET` | `/notifications` | `200 {"count":n,"notifications":[...]}`; optional `type` / `orderId` filters |
| `POST` | `/notifications/reset` | `200 {"reset":true,"removed":n}` |
| – | anything else | `404 {"error":"not_found"}` |

Validation: `Idempotency-Key` header required (`400 missing_idempotency_key`), body must be valid
JSON, `type` must be `ORDER_CONFIRMED` or `ORDER_CANCELLED` (`400 invalid_type`), `orderId` must be a
non-empty string (`400 invalid_order_id`), and `dedupeKey` must be a non-empty string equal to the
header value (`400 dedupe_key_mismatch`).

Determinism rules (they are the reason verification can assert exact counts):

* **No outbound network calls, ever.** The emulator serves and never dials out; it also runs
  correctly with `--network none`.
* **No randomness.** Identifiers echo the request's `Idempotency-Key`; ordering is insertion order
  with a `sequence` starting at 1; the only time-derived field is `receivedAt`.
* **State is in memory only.** Restarting the container clears the store, which is the same
  observable effect as `POST /notifications/reset`.
* **Deduplication on `Idempotency-Key`.** The first delivery stores a record and answers
  `duplicate: false`; every repeat answers `duplicate: true` and stores nothing. The API's durable
  outbox retries at least once, and the provider collapses the duplicates, so exactly-once delivery
  is a *logical* guarantee rather than a transport one.

`npm test` runs the contract suite with `node --test` (no test dependencies, every case starts the
server on an ephemeral port and closes it again).

## 8. Verification suite

`scripts/verify-e2e.mjs` is evaluator-style black-box verification. It runs **inside the compose
network** (`API_BASE_URL=http://api:8080`, `EMULATOR_BASE_URL=http://notification-emulator:4010`),
never touches host loopback, and talks HTTP only — no database access, no mocks.

```bash
docker compose --profile verify run --rm -e VERIFY_PHASE=full verify
docker compose --profile verify run --rm -e VERIFY_PHASE=durability-prepare verify
docker compose restart api
docker compose --profile verify run --rm -e VERIFY_PHASE=durability-assert verify
```

| Phase | What it proves |
| --- | --- |
| `full` (default) | Health, the frozen four-product seed table (ids, `sku`, `priceCents`, `availableQuantity`, name-ascending order), product detail, inventory rejection without side effects, unknown product/order/route handling, request and query validation, order creation with the exact total, inventory decrement, order detail, `SHIPPED` and its idempotent repeat, rejected cancellation of `SHIPPED`, all cancellation-reason rules, successful cancellation with a 200-character reason, exact-once inventory restore (sequential **and** concurrent), exactly-once confirmation and cancellation notifications, and an exact emulator record count proving no external provider was contacted |
| `durability-prepare` | Resets the provider store, creates an order, and snapshots `{orderId, espressoBefore, espressoAfter, totalCents, createdAt}` to `/verify-state/durability.json` **without** waiting for the notification, so delivery must survive a restart |
| `durability-assert` | After `docker compose restart api`: the order is still `CONFIRMED` with the same total and items, inventory is still decremented exactly once, and exactly one `ORDER_CONFIRMED` notification exists for the order |

Output contract: `PASS <check-id> :: <description>`, `FAIL <check-id> :: <description> :: <detail>`,
then `SUMMARY checks=<n> passed=<n> failed=<n>`; the exit code is `0` only when nothing failed. Every
HTTP failure detail carries the status code, the error code, and a truncated body. Notification
assertions poll the emulator for up to 10 seconds at 100 ms intervals.

Explicit limitation: the durability phase proves durable intent plus exactly-once *logical* delivery
across a restart. It does not prove the exact millisecond window between `COMMIT` and the HTTP call —
that window is covered by the outbox design (intent is committed with the state change) and by the
API's own integration test asserting an outbox row exists in the same transaction as the order.

## 9. Resetting and reproducibility

```bash
docker compose down -v      # stop everything and remove the postgres-data volume
docker compose up -d --build --wait
```

`down -v` removes the named volume `postgres-data` (project-scoped as `shopflow_postgres-data`), so
the next `up` re-runs `migrate` against an empty database and `seed` re-applies the fixed dataset.
The seed is deterministic: repeated resets produce byte-identical product rows and inventory
baselines, which is exactly what `VERIFY_PHASE=full` asserts.

The emulator needs no reset between runs: `VERIFY_PHASE=full` empties its store before the matrix,
and the durability phases do the same before creating their order.

## 10. Repository layout

```
shopflow-infra/
  docker-compose.yml              # services, network, volume, health checks, ordering
  .env.example                    # every variable, local-only defaults
  README.md
  postgres/postgresql.conf        # PostgreSQL 16 server configuration (mounted read-only)
  notification-emulator/
    package.json
    package-lock.json             # committed; used by npm ci in the image build
    Dockerfile                    # node:20-alpine, non-root, no runtime dependencies
    src/server.mjs                # http server built on node:http
    src/store.mjs                 # deduplicating in-memory notification store
    test/emulator.test.mjs        # node --test contract suite
  scripts/verify-e2e.mjs          # black-box matrix: full | durability-prepare | durability-assert
  verify-state/                   # git-ignored bind mount for the durability phases
  .gitignore
```

## 11. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `web` build fails with `open Dockerfile: no such file or directory` | `../shopflow-web` is not checked out (or `WEB_BUILD_CONTEXT` points elsewhere). The web tier is a separate repository; only its image is built here. |
| `postgres` reports `could not access the server configuration file "/etc/shopflow/postgresql.conf": I/O error` | Docker Desktop for Windows shares host files with the container, but its file-sharing layer does not grant a **non-root** container user (the `postgres` user, uid 70) read access when the host path is long — ~190 characters fail in the environment where this was diagnosed, a ~145-character path works, and the failure is reproducible with a plain copy of the file at a long path. The API image build (daemon side) and the `verify` service (runs as root) are unaffected; only the `postgres` config bind mount is. Fix it by checking the repositories out at a shorter path (for example `C:\src\shopflow-infra`) — or, if the checkout must stay where it is, bind the same file from a short path with a local override file that is kept out of the repository: `docker compose -f docker-compose.yml -f my-local-override.yml up -d --wait`, where the override re-declares `postgres.volumes` with the same `/etc/shopflow/postgresql.conf` target pointing at the readable copy. `postgres/postgresql.conf` stays the source of truth. |
| `api` never becomes healthy | Check `docker compose logs api`; the API refuses to start without `DATABASE_URL`/`NOTIFICATION_PROVIDER_URL` and reports database errors on `/health` as `503`. |
| A `verify` phase fails with `status=... code=... body=...` | The detail contains the failing request, the status, the error code, and the (truncated) body. Re-run `docker compose up -d --wait` first: the phases assert against a freshly seeded system. |
| `durability-assert` fails on `durability-state` | Run `VERIFY_PHASE=durability-prepare`, then `docker compose restart api`, then `VERIFY_PHASE=durability-assert`; the state file lives in `verify-state/durability.json`. |

## 12. Scope

In scope: `docker-compose.yml`, `.env.example`, `README.md`, `postgres/postgresql.conf`, the
notification emulator (code, tests, Dockerfile, lockfile), the migration/seed orchestration services,
and the verification suite under `scripts/`.

Out of scope and deliberately absent: application or domain logic, any product HTTP endpoint, any
React code, Kubernetes, cloud infrastructure, TLS termination, reverse proxies, monitoring stacks, CI
pipelines, production secrets management, and any dependency on a production internet service — the
stack runs fully offline once images are cached.
