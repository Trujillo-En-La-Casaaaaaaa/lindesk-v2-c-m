# ShopFlow Web

Browser single-page application for ShopFlow. It lets a customer browse the product catalog with live
availability, create an order, follow an order's status, cancel an unshipped order with a required reason,
and lets an administrator mark a confirmed order as `SHIPPED`.

The app is a static React + TypeScript bundle built with Vite. It talks **only** to the `shopflow-api`
HTTP contract (`GET/POST /api/...`); it holds no business rule of its own beyond the input validation
needed for a good user experience. There is no backend-for-frontend, no server rendering and no
authentication.

## Screens

| Route | Screen | Purpose |
| --- | --- | --- |
| `/` | Catalog (`src/pages/CatalogPage.tsx`) | Products with price and live availability; quantity selector and "Create order" per product. Creating an order navigates to the order detail route and confirms that a confirmation notification was requested. An `INSUFFICIENT_INVENTORY` rejection shows the offending product with the available quantity from `error.details` and refreshes the catalog. |
| `/orders/:orderId` | Order detail (`src/pages/OrderDetailPage.tsx`) | Order id, status badge, line items, total, `createdAt`, and `shippedAt` / `cancelledAt` / `cancellationReason` when present. While the status is `CONFIRMED` the cancellation form is available; after a successful cancellation the screen shows `CANCELLED` plus the notification confirmation. A shipped order is reported as not cancellable. |
| `/admin` | Admin orders (`src/pages/AdminOrdersPage.tsx`) | Table of orders (id, customer, status, total, creation time) with "Mark as SHIPPED" enabled only for `CONFIRMED` orders; after success the list is refreshed and the action confirmed. An already cancelled order is reported. |

The shared shell (`src/App.tsx`) provides the layout, the navigation and the typed API client to every
screen. Reusable presentation lives in `src/components/`: `ProductCard`, `OrderStatusBadge`,
`CancelOrderForm`, `ErrorBanner` and `OrderItemsTable`.

## Cancellation rules (mirrored from the API contract)

- The reason is required: the trimmed value must not be empty and the submit button stays disabled with an
  inline message tied to the field (`aria-describedby`, `aria-invalid`).
- The trimmed reason must be **at most 200 characters**; a live counter shows `used / 200`. Exactly 200
  characters is accepted, 201 is rejected.
- The submit button is disabled while a request is in flight, so a cancellation cannot be submitted twice.
- A `200` response always renders the stored `CANCELLED` state with `cancelledAt`, `cancellationReason` and
  the notification confirmation; a repeat `200` for an already cancelled order renders identically and
  never implies a second inventory restore.
- `409 ORDER_ALREADY_SHIPPED` replaces the form with a message stating that shipped orders cannot be
  cancelled.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `VITE_API_BASE_URL` | no | `http://localhost:8080` | Origin of `shopflow-api`; the app appends `/api`. Injected at build time by `shopflow-infra` as a Docker build argument. |

Copy `.env.example` to `.env` for local development. `VITE_API_BASE_URL` is the only configuration surface;
the API must be reachable from the browser. The API base URL is resolved in `src/api/client.ts`
(`resolveApiBaseUrl`).

The demo customer identifier is stored under the `localStorage` key `shopflow.customerId` and defaults to
`customer-demo`; it exists only so a created order has an owner.

## Requirements

- Node.js 20 or newer (`node:20-alpine` is used for the container build) and npm.

## Setup

```
npm ci          # install from the committed package-lock.json
```

Then point the app at a running `shopflow-api` and start the dev server:

```
# .env
VITE_API_BASE_URL=http://localhost:8080

npm run dev     # http://localhost:5173
```

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Vite development server with hot module replacement. |
| `npm run build` | Production build into `dist/` (`index.html` plus hashed JS/CSS assets). |
| `npm run preview` | Serves the built `dist/` bundle locally. |
| `npm run typecheck` | `tsc --noEmit` over the app and the Vite configuration (strict mode). |
| `npm test` | Runs the Vitest suite once (jsdom environment). |

## Tests

```
npm ci
npm run typecheck
npm run build
npm test
```

| Test file | Covers |
| --- | --- |
| `tests/api-client.test.ts` | URL/method/body of every client call, response unwrapping, error-envelope parsing into `ApiError` (`code`, `message`, `details`), non-JSON bodies, network failures, the `INSUFFICIENT_INVENTORY` details reader and the demo customer id. |
| `tests/catalog-page.test.tsx` | Catalog rendering of API products with price and availability, loading and error states, order creation payload + navigation + confirmation banner, and `INSUFFICIENT_INVENTORY` details with a catalog refresh. |
| `tests/order-detail-page.test.tsx` | Order detail for every status, distinct status badges, cancellation reason boundaries (empty, 200 and 201 characters, trimming), successful cancellation rendering, in-flight duplicate-submit guard, and `ORDER_ALREADY_SHIPPED`. |
| `tests/admin-orders-page.test.tsx` | Order table contents, `CONFIRMED`-only ship action, ship request + list refresh + confirmation, and `ORDER_ALREADY_CANCELLED`. |

The tests replace `fetch` with a local stub; no mock server ships in `src/`.

## Container

```
docker build --build-arg VITE_API_BASE_URL=http://localhost:8080 -t shopflow-web .
docker run --rm -p 8081:80 shopflow-web
```

The multi-stage build runs `npm ci` and `npm run build` on `node:20-alpine`, then serves `dist/` from
`nginx:1.27-alpine` on port 80. `nginx.conf` serves the SPA (`try_files $uri /index.html`) and contains no
API proxy: the browser calls the configured API base URL directly.

## Notes and limitations

- The screens can only be exercised end to end while `shopflow-api` is running and reachable from the
  browser at `VITE_API_BASE_URL`; the UI never falls back to local or bundled data.
- There is no authentication, account or session handling by design. The demo customer id in
  `localStorage` is the only identity and no credential or token is ever stored.
- `npm audit` reports two moderate advisories in `@vitest/mocker`, a development-only test dependency that
  the suites do not use (no module-redirect mocks) and that never reaches the `dist/` bundle. Clearing them
  requires the vitest 5 / vite 8 major upgrade, which is deferred to keep the build deterministic.

## Project layout

```
src/
  main.tsx                     # React entry point + BrowserRouter
  App.tsx                      # app shell: layout, routes, API client provider
  api/client.ts                # typed fetch client and ApiError
  api/types.ts                 # ProductView, OrderView, error codes, contract constants
  lib/format.ts                # money and timestamp display formatting
  pages/                       # catalog, order detail, admin orders
  components/                  # product card, status badge, cancellation form, banners, items table
  styles.css
tests/                         # Vitest suites (jsdom + Testing Library)
```
