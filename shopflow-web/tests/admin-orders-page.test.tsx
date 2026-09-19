import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { createApiClient } from "../src/api/client";
import type { OrderView } from "../src/api/types";

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

function renderAdmin() {
  const apiClient = createApiClient({ baseUrl: BASE_URL });
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <App apiClient={apiClient} />
    </MemoryRouter>,
  );
}

function buildOrder(overrides: Partial<OrderView> & Pick<OrderView, "id" | "status">): OrderView {
  return {
    customerId: "customer-demo",
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
    ...overrides,
  };
}

const confirmedOrder = buildOrder({ id: "o-1", status: "CONFIRMED" });
const shippedOrder = buildOrder({
  id: "o-2",
  status: "SHIPPED",
  customerId: "customer-shipped",
  shippedAt: "2026-01-06T09:00:00.000Z",
});
const cancelledOrder = buildOrder({
  id: "o-3",
  status: "CANCELLED",
  customerId: "customer-cancelled",
  cancelledAt: "2026-01-06T10:00:00.000Z",
  cancellationReason: "Found a better deal",
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("AdminOrdersPage", () => {
  it("renders the orders table with id, customer, status, total and creation time", async () => {
    const requests = stubFetch(() => json(200, { orders: [confirmedOrder, shippedOrder, cancelledOrder] }));

    renderAdmin();

    const confirmedRow = await screen.findByRole("row", { name: /o-1/ });
    expect(within(confirmedRow).getByRole("rowheader", { name: "o-1" })).toBeInTheDocument();
    expect(within(confirmedRow).getByText("customer-demo")).toBeInTheDocument();
    expect(within(confirmedRow).getByText("CONFIRMED")).toBeInTheDocument();
    expect(within(confirmedRow).getByText(/25\.98/)).toBeInTheDocument();
    expect(within(confirmedRow).getByText("2026-01-05 15:04:05 UTC")).toBeInTheDocument();

    expect(within(screen.getByRole("row", { name: /o-2/ })).getByText("SHIPPED")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /o-3/ })).getByText("CANCELLED")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Order id" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Customer" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Total" })).toBeInTheDocument();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${BASE_URL}/api/orders?limit=50`);
  });

  it("enables Mark as SHIPPED only for confirmed orders", async () => {
    stubFetch(() => json(200, { orders: [confirmedOrder, shippedOrder, cancelledOrder] }));

    renderAdmin();

    await screen.findByRole("row", { name: /o-1/ });
    expect(
      within(screen.getByRole("row", { name: /o-1/ })).getByRole("button", { name: "Mark as SHIPPED" }),
    ).toBeEnabled();
    expect(
      within(screen.getByRole("row", { name: /o-2/ })).getByRole("button", { name: "Mark as SHIPPED" }),
    ).toBeDisabled();
    expect(
      within(screen.getByRole("row", { name: /o-3/ })).getByRole("button", { name: "Mark as SHIPPED" }),
    ).toBeDisabled();
  });

  it("marks a confirmed order as SHIPPED, refreshes the list and confirms the notification request", async () => {
    let listCalls = 0;
    const requests = stubFetch((request) => {
      if (request.path === "/api/orders" && request.method === "GET") {
        listCalls += 1;
        return json(200, { orders: [listCalls === 1 ? confirmedOrder : shippedOrder] });
      }
      if (request.path === "/api/orders/o-1/ship" && request.method === "POST") {
        return json(200, { order: { ...confirmedOrder, status: "SHIPPED" } });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });

    renderAdmin();

    await screen.findByRole("row", { name: /o-1/ });
    fireEvent.click(screen.getByRole("button", { name: "Mark as SHIPPED" }));

    await waitFor(() => {
      expect(requests.filter((request) => request.path === "/api/orders/o-1/ship")).toHaveLength(1);
    });

    const shipRequest = requests.find((request) => request.path === "/api/orders/o-1/ship");
    expect(shipRequest?.url).toBe(`${BASE_URL}/api/orders/o-1/ship`);
    expect(shipRequest?.headers["content-type"]).toBe("application/json");
    expect(shipRequest?.body).toEqual({});

    await waitFor(() => {
      expect(requests.filter((request) => request.path === "/api/orders")).toHaveLength(2);
    });

    expect(await screen.findByText("SHIPPED")).toBeInTheDocument();
    expect(
      screen.getByText(/Order o-1 was marked as SHIPPED and a shipping notification was requested\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark as SHIPPED" })).toBeDisabled();
    expect(requests.every((request) => request.url.startsWith(BASE_URL))).toBe(true);
  });

  it("reports an already cancelled order when the ship action is rejected", async () => {
    stubFetch((request) => {
      if (request.path === "/api/orders/o-1/ship") {
        return json(409, {
          error: {
            code: "ORDER_ALREADY_CANCELLED",
            message: "Order o-1 was already cancelled",
            details: {},
          },
        });
      }
      return json(200, { orders: [confirmedOrder] });
    });

    renderAdmin();

    await screen.findByRole("row", { name: /o-1/ });
    fireEvent.click(screen.getByRole("button", { name: "Mark as SHIPPED" }));

    expect(await screen.findByText("The order was already cancelled")).toBeInTheDocument();
    expect(
      screen.getByText("Order o-1 was already cancelled, so it cannot be marked as SHIPPED."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/shipping notification was requested/)).not.toBeInTheDocument();
  });

  it("shows an error banner when the order list cannot be loaded", async () => {
    stubFetch(() =>
      json(503, {
        error: { code: "SERVICE_UNAVAILABLE", message: "The order service is unavailable" },
      }),
    );

    renderAdmin();

    expect(await screen.findByText("The orders could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("The order service is unavailable")).toBeInTheDocument();
  });
});
