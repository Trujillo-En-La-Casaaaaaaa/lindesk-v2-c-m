import type {
  ApiErrorEnvelope,
  CreateOrderInput,
  InsufficientInventoryDetails,
  OrderView,
  ProductView,
} from "./types";

/** Fallback API origin used when `VITE_API_BASE_URL` is not configured. */
export const DEFAULT_API_BASE_URL = "http://localhost:8080";

/** Path prefix appended to the configured base URL for every ShopFlow API call. */
const API_PREFIX = "/api";

export const DEFAULT_CUSTOMER_ID = "customer-demo";
export const CUSTOMER_ID_STORAGE_KEY = "shopflow.customerId";

export type ApiErrorDetails = Record<string, unknown>;

/**
 * Typed representation of the ShopFlow API error envelope. Every failure the UI
 * can observe (HTTP error status, unparseable body, unreachable host) surfaces
 * as an `ApiError`, never as a raw `SyntaxError` or a rejected `fetch` promise.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: ApiErrorDetails;

  constructor(input: { code: string; message: string; status?: number; details?: ApiErrorDetails }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code;
    this.status = input.status ?? 0;
    this.details = input.details ?? {};
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Message suitable for an error banner; never leaks a stack or parse error. */
export function describeApiError(error: unknown): string {
  if (isApiError(error)) {
    return error.message;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "An unexpected error occurred while talking to the ShopFlow API.";
}

/** Resolves the API origin: explicit override, then build-time env, then default. */
export function resolveApiBaseUrl(override?: string): string {
  const configured: unknown = override ?? import.meta.env.VITE_API_BASE_URL;
  const value = typeof configured === "string" ? configured.trim() : "";
  const base = value.length > 0 ? value : DEFAULT_API_BASE_URL;
  return base.replace(/\/+$/, "");
}

/**
 * Reads the demo customer identifier from `localStorage`, seeding the documented
 * default the first time. This exists only so an order has an owner; the app has
 * no authentication, accounts or sessions.
 */
export function getCustomerId(storage?: Pick<Storage, "getItem" | "setItem">): string {
  const store = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  if (store === undefined) {
    return DEFAULT_CUSTOMER_ID;
  }
  try {
    const stored = store.getItem(CUSTOMER_ID_STORAGE_KEY);
    if (typeof stored === "string" && stored.trim().length > 0) {
      return stored;
    }
    store.setItem(CUSTOMER_ID_STORAGE_KEY, DEFAULT_CUSTOMER_ID);
  } catch {
    // Storage can be unavailable (private mode, disabled cookies); the demo id still works.
    return DEFAULT_CUSTOMER_ID;
  }
  return DEFAULT_CUSTOMER_ID;
}

export function readInsufficientInventoryDetails(
  details: ApiErrorDetails,
): InsufficientInventoryDetails | null {
  const { productId, requested, available } = details;
  if (typeof productId === "string" && typeof requested === "number" && typeof available === "number") {
    return { productId, requested, available };
  }
  return null;
}

export interface ApiClientOptions {
  /** API origin; defaults to `VITE_API_BASE_URL` and then `http://localhost:8080`. */
  baseUrl?: string;
  /** Transport override used by tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The typed ShopFlow REST API surface consumed by the screens. */
export interface ShopFlowApiClient {
  readonly baseUrl: string;
  listProducts(): Promise<ProductView[]>;
  getProduct(productId: string): Promise<ProductView>;
  createOrder(input: CreateOrderInput): Promise<OrderView>;
  getOrder(orderId: string): Promise<OrderView>;
  listOrders(limit?: number): Promise<OrderView[]>;
  cancelOrder(orderId: string, reason: string): Promise<OrderView>;
  shipOrder(orderId: string): Promise<OrderView>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (!isRecord(value) || !isRecord(value.error)) {
    return false;
  }
  return typeof value.error.code === "string" && typeof value.error.message === "string";
}

function envelopeDetails(value: unknown): ApiErrorDetails {
  if (isErrorEnvelope(value) && isRecord(value.error.details)) {
    return value.error.details;
  }
  return {};
}

async function readBody(response: Response): Promise<{ parsed: boolean; body: unknown }> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { parsed: false, body: undefined };
  }
  if (text.trim().length === 0) {
    return { parsed: false, body: undefined };
  }
  try {
    return { parsed: true, body: JSON.parse(text) as unknown };
  } catch {
    return { parsed: false, body: undefined };
  }
}

function toResponseError(status: number, body: unknown): ApiError {
  if (isErrorEnvelope(body)) {
    return new ApiError({
      code: body.error.code,
      message: body.error.message,
      status,
      details: envelopeDetails(body),
    });
  }
  return new ApiError({
    code: "UNEXPECTED_RESPONSE",
    message: `The ShopFlow API returned an unexpected response (HTTP ${status}).`,
    status,
  });
}

function readProducts(payload: unknown): ProductView[] {
  if (isRecord(payload) && Array.isArray(payload.products)) {
    return payload.products as ProductView[];
  }
  throw new ApiError({
    code: "INVALID_RESPONSE",
    message: "The ShopFlow API did not return a product list.",
  });
}

function readProduct(payload: unknown): ProductView {
  if (isRecord(payload) && isRecord(payload.product)) {
    return payload.product as unknown as ProductView;
  }
  throw new ApiError({
    code: "INVALID_RESPONSE",
    message: "The ShopFlow API did not return a product.",
  });
}

function readOrder(payload: unknown): OrderView {
  if (isRecord(payload) && isRecord(payload.order)) {
    return payload.order as unknown as OrderView;
  }
  throw new ApiError({
    code: "INVALID_RESPONSE",
    message: "The ShopFlow API did not return an order.",
  });
}

function readOrders(payload: unknown): OrderView[] {
  if (isRecord(payload) && Array.isArray(payload.orders)) {
    return payload.orders as OrderView[];
  }
  throw new ApiError({
    code: "INVALID_RESPONSE",
    message: "The ShopFlow API did not return an order list.",
  });
}

const jsonHeaders = {
  accept: "application/json",
  "content-type": "application/json",
} as const;

export function createApiClient(options: ApiClientOptions = {}): ShopFlowApiClient {
  const baseUrl = resolveApiBaseUrl(options.baseUrl);
  const send: typeof fetch =
    options.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await send(`${baseUrl}${path}`, init);
    } catch {
      throw new ApiError({
        code: "NETWORK_ERROR",
        message:
          "The ShopFlow API could not be reached. Check that the API is running and reachable from the browser.",
      });
    }

    const { parsed, body } = await readBody(response);

    if (!response.ok) {
      throw toResponseError(response.status, parsed ? body : undefined);
    }
    if (!parsed) {
      throw new ApiError({
        code: "INVALID_RESPONSE",
        message: "The ShopFlow API returned a response that is not valid JSON.",
        status: response.status,
      });
    }
    return body as T;
  }

  return {
    baseUrl,

    async listProducts(): Promise<ProductView[]> {
      return readProducts(await request<unknown>(`${API_PREFIX}/products`));
    },

    async getProduct(productId: string): Promise<ProductView> {
      return readProduct(await request<unknown>(`${API_PREFIX}/products/${encodeURIComponent(productId)}`));
    },

    async createOrder(input: CreateOrderInput): Promise<OrderView> {
      return readOrder(
        await request<unknown>(`${API_PREFIX}/orders`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(input),
        }),
      );
    },

    async getOrder(orderId: string): Promise<OrderView> {
      return readOrder(await request<unknown>(`${API_PREFIX}/orders/${encodeURIComponent(orderId)}`));
    },

    async listOrders(limit = 50): Promise<OrderView[]> {
      return readOrders(
        await request<unknown>(`${API_PREFIX}/orders?limit=${encodeURIComponent(String(limit))}`),
      );
    },

    async cancelOrder(orderId: string, reason: string): Promise<OrderView> {
      return readOrder(
        await request<unknown>(`${API_PREFIX}/orders/${encodeURIComponent(orderId)}/cancel`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ reason }),
        }),
      );
    },

    async shipOrder(orderId: string): Promise<OrderView> {
      return readOrder(
        await request<unknown>(`${API_PREFIX}/orders/${encodeURIComponent(orderId)}/ship`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({}),
        }),
      );
    },
  };
}

/** Application-wide client built from the build-time configuration. */
export const apiClient: ShopFlowApiClient = createApiClient();
