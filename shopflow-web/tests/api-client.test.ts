import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  CUSTOMER_ID_STORAGE_KEY,
  DEFAULT_API_BASE_URL,
  DEFAULT_CUSTOMER_ID,
  createApiClient,
  describeApiError,
  getCustomerId,
  isApiError,
  readInsufficientInventoryDetails,
  resolveApiBaseUrl,
} from "../src/api/client";
import type { OrderView, ProductView } from "../src/api/types";

const BASE_URL = "http://api.test:8080";

interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

type StubReply = { status: number; text: string };

function json(status: number, payload: unknown): StubReply {
  return { status, text: JSON.stringify(payload) };
}

function text(status: number, payload: string): StubReply {
  return { status, text: payload };
}

/** Records every request and answers from the supplied handler. */
function createStub(handler: (request: RecordedRequest) => StubReply | Promise<StubReply>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      path: parsed.pathname,
      search: parsed.search,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    requests.push(request);
    const reply = await handler(request);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => reply.text,
    } as unknown as Response;
  });
  return { requests, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const product: ProductView = {
  id: "p-1",
  sku: "SKU-1",
  name: "Espresso machine",
  description: "Compact 15-bar espresso machine.",
  priceCents: 1299,
  currency: "USD",
  availableQuantity: 4,
};

const order: OrderView = {
  id: "o-1",
  customerId: "customer-demo",
  status: "CONFIRMED",
  totalCents: 2598,
  currency: "USD",
  createdAt: "2026-01-05T15:04:05.000Z",
  updatedAt: "2026-01-05T15:04:05.000Z",
  shippedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  items: [
    {
      productId: "p-1",
      productName: "Espresso machine",
      quantity: 2,
      unitPriceCents: 1299,
      lineTotalCents: 2598,
    },
  ],
};

describe("resolveApiBaseUrl", () => {
  it("defaults to the documented API base URL when nothing is configured", () => {
    const configured = import.meta.env.VITE_API_BASE_URL;
    if (typeof configured === "string" && configured.trim().length > 0) {
      expect(resolveApiBaseUrl()).toBe(configured.trim().replace(/\/+$/, ""));
    } else {
      expect(DEFAULT_API_BASE_URL).toBe("http://localhost:8080");
      expect(resolveApiBaseUrl()).toBe(DEFAULT_API_BASE_URL);
    }
  });

  it("prefers an explicit override and strips trailing slashes", () => {
    expect(resolveApiBaseUrl("https://shopflow.example.test/")).toBe("https://shopflow.example.test");
    expect(resolveApiBaseUrl("  https://shopflow.example.test/api/  ")).toBe("https://shopflow.example.test/api");
  });
});

describe("ShopFlow API client requests", () => {
  it("lists products through GET /api/products and unwraps the envelope", async () => {
    const { requests, fetchImpl } = createStub(() => json(200, { products: [product] }));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.listProducts()).resolves.toEqual([product]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(`${BASE_URL}/api/products`);
  });

  it("fetches a single product through GET /api/products/:id", async () => {
    const { requests, fetchImpl } = createStub(() => json(200, { product }));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.getProduct("p 1")).resolves.toEqual(product);
    expect(requests[0]?.url).toBe(`${BASE_URL}/api/products/p%201`);
  });

  it("creates an order with POST /api/orders and the documented payload", async () => {
    const { requests, fetchImpl } = createStub(() => json(201, { order }));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const created = await client.createOrder({
      customerId: "customer-demo",
      items: [{ productId: "p-1", quantity: 2 }],
    });

    expect(created).toEqual(order);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe(`${BASE_URL}/api/orders`);
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
    expect(requests[0]?.body).toEqual({ customerId: "customer-demo", items: [{ productId: "p-1", quantity: 2 }] });
  });

  it("reads an order through GET /api/orders/:id", async () => {
    const { requests, fetchImpl } = createStub(() => json(200, { order }));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.getOrder("o-1")).resolves.toEqual(order);
    expect(requests[0]?.url).toBe(`${BASE_URL}/api/orders/o-1`);
  });

  it("lists orders with the default and explicit limit query parameter", async () => {
    const { requests, fetchImpl } = createStub(() => json(200, { orders: [order] }));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.listOrders()).resolves.toEqual([order]);
    await expect(client.listOrders(5)).resolves.toEqual([order]);

    expect(requests[0]?.url).toBe(`${BASE_URL}/api/orders?limit=50`);
    expect(requests[0]?.search).toBe("?limit=50");
    expect(requests[1]?.url).toBe(`${BASE_URL}/api/orders?limit=5`);
  });

  it("cancels an order with POST /api/orders/:id/cancel carrying the reason", async () => {
    const cancelled: OrderView = {
      ...order,
      status: "CANCELLED",
      cancelledAt: "2026-01-06T10:00:00.000Z",
      cancellationReason: "Found a better deal",
    };
    const { requests, fetchImpl } = createStub(() => json(200, { order: cancelled }));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.cancelOrder("o-1", "Found a better deal")).resolves.toEqual(cancelled);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe(`${BASE_URL}/api/orders/o-1/cancel`);
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
    expect(requests[0]?.body).toEqual({ reason: "Found a better deal" });
  });

  it("ships an order with POST /api/orders/:id/ship and an empty body", async () => {
    const { requests, fetchImpl } = createStub(() => json(200, { order: { ...order, status: "SHIPPED" } }));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.shipOrder("o-1")).resolves.toMatchObject({ id: "o-1", status: "SHIPPED" });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe(`${BASE_URL}/api/orders/o-1/ship`);
    expect(requests[0]?.body).toEqual({});
  });
});

describe("ShopFlow API client error handling", () => {
  it("parses the API error envelope into ApiError with code, message and details", async () => {
    const { fetchImpl } = createStub(() =>
      json(409, {
        error: {
          code: "INSUFFICIENT_INVENTORY",
          message: "Product p-1 has insufficient inventory",
          details: { productId: "p-1", requested: 5, available: 3 },
        },
      }),
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const failure = await client.createOrder({ customerId: "customer-demo", items: [{ productId: "p-1", quantity: 5 }] })
      .catch((error: unknown) => error);

    expect(isApiError(failure)).toBe(true);
    const apiError = failure as ApiError;
    expect(apiError.code).toBe("INSUFFICIENT_INVENTORY");
    expect(apiError.message).toBe("Product p-1 has insufficient inventory");
    expect(apiError.status).toBe(409);
    expect(apiError.details).toEqual({ productId: "p-1", requested: 5, available: 3 });
    expect(readInsufficientInventoryDetails(apiError.details)).toEqual({
      productId: "p-1",
      requested: 5,
      available: 3,
    });
  });

  it("never surfaces a raw JSON parse error for a non-JSON error body", async () => {
    const { fetchImpl } = createStub(() => text(502, "<html>Bad gateway</html>"));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const failure = await client.listProducts().catch((error: unknown) => error);
    expect(isApiError(failure)).toBe(true);
    expect((failure as ApiError).code).toBe("UNEXPECTED_RESPONSE");
    expect((failure as ApiError).status).toBe(502);
    expect((failure as ApiError).details).toEqual({});
    expect(describeApiError(failure)).not.toMatch(/JSON at position|Unexpected token/);
  });

  it("reports a successful response that is not JSON as INVALID_RESPONSE", async () => {
    const { fetchImpl } = createStub(() => text(200, "not json at all"));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const failure = await client.getOrder("o-1").catch((error: unknown) => error);
    expect(isApiError(failure)).toBe(true);
    expect((failure as ApiError).code).toBe("INVALID_RESPONSE");
    expect(failure).not.toBeInstanceOf(SyntaxError);
  });

  it("reports an unexpected success envelope as INVALID_RESPONSE", async () => {
    const { fetchImpl } = createStub(() => json(200, { products: "not-an-array" }));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const failure = await client.listProducts().catch((error: unknown) => error);
    expect(isApiError(failure)).toBe(true);
    expect((failure as ApiError).code).toBe("INVALID_RESPONSE");
  });

  it("reports an unreachable API as NETWORK_ERROR", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const failure = await client.listProducts().catch((error: unknown) => error);
    expect(isApiError(failure)).toBe(true);
    expect((failure as ApiError).code).toBe("NETWORK_ERROR");
    expect((failure as ApiError).status).toBe(0);
    expect(describeApiError(failure)).toMatch(/could not be reached/i);
  });

  it("describes unknown failures without leaking internals", () => {
    expect(describeApiError(new Error("boom"))).toBe("boom");
    expect(describeApiError("boom")).toMatch(/unexpected error/i);
    expect(describeApiError(undefined)).toMatch(/unexpected error/i);
    expect(isApiError(new Error("boom"))).toBe(false);
  });

  it("rejects malformed inventory details instead of guessing", () => {
    expect(readInsufficientInventoryDetails({ productId: "p-1", requested: "5", available: 3 })).toBeNull();
    expect(readInsufficientInventoryDetails({})).toBeNull();
  });
});

describe("demo customer identity", () => {
  it("uses and seeds the documented default identifier", () => {
    window.localStorage.clear();
    expect(getCustomerId()).toBe(DEFAULT_CUSTOMER_ID);
    expect(window.localStorage.getItem(CUSTOMER_ID_STORAGE_KEY)).toBe(DEFAULT_CUSTOMER_ID);
  });

  it("returns the stored identifier when one exists", () => {
    window.localStorage.setItem(CUSTOMER_ID_STORAGE_KEY, "customer-42");
    expect(getCustomerId()).toBe("customer-42");
  });

  it("falls back to the default when storage is unavailable", () => {
    const blocked = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    };
    expect(getCustomerId(blocked)).toBe(DEFAULT_CUSTOMER_ID);
  });
});
