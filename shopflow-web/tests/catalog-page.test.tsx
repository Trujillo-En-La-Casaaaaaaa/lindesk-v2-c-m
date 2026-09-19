import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { createApiClient } from "../src/api/client";
import type { OrderView, ProductView } from "../src/api/types";

const BASE_URL = "http://test.local:8080";

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

function createDeferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}

function stubFetch(handler: (request: RecordedRequest) => StubReply | Promise<StubReply>) {
  const requests: RecordedRequest[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
  vi.stubGlobal("fetch", stub);
  return requests;
}

function renderCatalog() {
  const apiClient = createApiClient({ baseUrl: BASE_URL });
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <App apiClient={apiClient} />
    </MemoryRouter>,
  );
}

const espresso: ProductView = {
  id: "p-1",
  sku: "SKU-ESPRESSO",
  name: "Espresso machine",
  description: "Compact 15-bar espresso machine for home use.",
  priceCents: 129900,
  currency: "USD",
  availableQuantity: 3,
};

const grinder: ProductView = {
  id: "p-2",
  sku: "SKU-GRINDER",
  name: "Burr grinder",
  description: "Conical burr grinder with 15 settings.",
  priceCents: 8999,
  currency: "USD",
  availableQuantity: 7,
};

const createdOrder: OrderView = {
  id: "o-99",
  customerId: "customer-demo",
  status: "CONFIRMED",
  totalCents: 259800,
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
      unitPriceCents: 129900,
      lineTotalCents: 259800,
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("CatalogPage", () => {
  it("renders the products returned by the API with availability", async () => {
    const requests = stubFetch(() => json(200, { products: [espresso, grinder] }));

    renderCatalog();

    expect(await screen.findByRole("heading", { name: "Espresso machine" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Burr grinder" })).toBeInTheDocument();
    expect(screen.getByText("Compact 15-bar espresso machine for home use.")).toBeInTheDocument();
    expect(screen.getByText("Conical burr grinder with 15 settings.")).toBeInTheDocument();
    expect(screen.getByText(/1,299\.00/)).toBeInTheDocument();
    expect(screen.getByText(/89\.99/)).toBeInTheDocument();
    expect(screen.getByText("Available quantity: 3")).toBeInTheDocument();
    expect(screen.getByText("Available quantity: 7")).toBeInTheDocument();
    expect(screen.getByText("SKU SKU-ESPRESSO")).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${BASE_URL}/api/products`);
  });

  it("shows a loading state until the catalog response arrives", async () => {
    const gate = createDeferred();
    stubFetch(() => gate.promise.then(() => json(200, { products: [espresso] })));

    renderCatalog();

    expect(screen.getByText("Loading products…")).toBeInTheDocument();

    gate.resolve();

    expect(await screen.findByRole("heading", { name: "Espresso machine" })).toBeInTheDocument();
    expect(screen.queryByText("Loading products…")).not.toBeInTheDocument();
  });

  it("creates an order with the documented payload, navigates to the order route and confirms the notification request", async () => {
    const requests = stubFetch((request) => {
      if (request.path === "/api/products") {
        return json(200, { products: [espresso] });
      }
      if (request.path === "/api/orders" && request.method === "POST") {
        return json(201, { order: createdOrder });
      }
      if (request.path === "/api/orders/o-99") {
        return json(200, { order: createdOrder });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });

    renderCatalog();

    await screen.findByRole("heading", { name: "Espresso machine" });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    expect(await screen.findByRole("heading", { name: "Order o-99" })).toBeInTheDocument();
    expect(
      screen.getByText(/Order o-99 was created and a confirmation notification was requested\./),
    ).toBeInTheDocument();

    const createRequest = requests.find((request) => request.method === "POST");
    expect(createRequest?.url).toBe(`${BASE_URL}/api/orders`);
    expect(createRequest?.headers["content-type"]).toBe("application/json");
    expect(createRequest?.body).toEqual({
      customerId: "customer-demo",
      items: [{ productId: "p-1", quantity: 2 }],
    });
    expect(requests.every((request) => request.url.startsWith(BASE_URL))).toBe(true);
  });

  it("stores and reuses the demo customer identifier for order creation", async () => {
    window.localStorage.setItem("shopflow.customerId", "customer-42");
    const requests = stubFetch((request) => {
      if (request.path === "/api/products") {
        return json(200, { products: [espresso] });
      }
      if (request.path === "/api/orders") {
        return json(201, { order: { ...createdOrder, customerId: "customer-42" } });
      }
      return json(200, { order: { ...createdOrder, customerId: "customer-42" } });
    });

    renderCatalog();

    await screen.findByRole("heading", { name: "Espresso machine" });
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    await screen.findByRole("heading", { name: "Order o-99" });
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({
      customerId: "customer-42",
      items: [{ productId: "p-1", quantity: 1 }],
    });
  });

  it("reports insufficient inventory with the available quantity from error details and refreshes the catalog", async () => {
    let catalogCalls = 0;
    const requests = stubFetch((request) => {
      if (request.path === "/api/products") {
        catalogCalls += 1;
        return json(200, {
          products: [catalogCalls === 1 ? espresso : { ...espresso, availableQuantity: 1 }],
        });
      }
      if (request.path === "/api/orders" && request.method === "POST") {
        return json(409, {
          error: {
            code: "INSUFFICIENT_INVENTORY",
            message: "Product p-1 has insufficient inventory",
            details: { productId: "p-1", requested: 5, available: 3 },
          },
        });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });

    renderCatalog();

    await screen.findByRole("heading", { name: "Espresso machine" });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    expect(await screen.findByText(/Not enough inventory for Espresso machine/)).toBeInTheDocument();
    expect(screen.getByText(/only 3 available, 5 requested/)).toBeInTheDocument();

    await waitFor(() => {
      expect(requests.filter((request) => request.path === "/api/products")).toHaveLength(2);
    });
    expect(await screen.findByText("Available quantity: 1")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Product catalog" })).toBeInTheDocument();
  });

  it("shows an error banner when the catalog cannot be loaded", async () => {
    stubFetch(() =>
      json(500, {
        error: { code: "INTERNAL_ERROR", message: "The catalog service is unavailable" },
      }),
    );

    renderCatalog();

    expect(await screen.findByText("The catalog could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("The catalog service is unavailable")).toBeInTheDocument();
  });

  it("blocks order creation while the quantity is not a positive whole number", async () => {
    stubFetch(() => json(200, { products: [espresso] }));

    renderCatalog();

    await screen.findByRole("heading", { name: "Espresso machine" });
    const createButton = screen.getByRole("button", { name: "Create order" });
    expect(createButton).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "0" } });
    expect(screen.getByText("Enter a whole number of 1 or more.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create order" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Create order" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "3" } });
    expect(screen.getByRole("button", { name: "Create order" })).toBeEnabled();
  });
});
