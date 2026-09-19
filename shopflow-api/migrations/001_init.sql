-- ShopFlow canonical schema (authoritative for shopflow-api/migrations/001_init.sql).
-- PostgreSQL 16. Applied by `npm run migrate`; the same DDL is verified by shopflow-infra.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id          text PRIMARY KEY,
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  currency    text NOT NULL DEFAULT 'USD',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory (
  product_id         text PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  available_quantity integer NOT NULL CHECK (available_quantity >= 0),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id                  text PRIMARY KEY,
  customer_id         text NOT NULL,
  status              text NOT NULL CHECK (status IN ('CONFIRMED','SHIPPED','CANCELLED')),
  total_cents         integer NOT NULL CHECK (total_cents >= 0),
  currency            text NOT NULL DEFAULT 'USD',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  shipped_at          timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text,
  CONSTRAINT orders_shipped_fields CHECK (
    (status = 'SHIPPED' AND shipped_at IS NOT NULL)
    OR (status <> 'SHIPPED' AND shipped_at IS NULL)
  ),
  CONSTRAINT orders_cancellation_fields CHECK (
    (status = 'CANCELLED'
      AND cancelled_at IS NOT NULL
      AND cancellation_reason IS NOT NULL
      AND length(cancellation_reason) BETWEEN 1 AND 200)
    OR (status <> 'CANCELLED'
      AND cancelled_at IS NULL
      AND cancellation_reason IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id               text PRIMARY KEY,
  order_id         text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       text NOT NULL REFERENCES products(id),
  product_name     text NOT NULL,
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents integer NOT NULL CHECK (line_total_cents >= 0),
  UNIQUE (order_id, product_id)
);

CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id         text PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  type       text NOT NULL CHECK (type IN ('ORDER_CONFIRMED','ORDER_CANCELLED')),
  order_id   text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

CREATE INDEX IF NOT EXISTS notification_outbox_dispatch_idx
  ON notification_outbox(status, created_at);
