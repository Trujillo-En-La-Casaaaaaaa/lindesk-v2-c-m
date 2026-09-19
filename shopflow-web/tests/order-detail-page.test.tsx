import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { createApiClient } from "../src/api/client";
import type { OrderView } from "../src/api/types";
import OrderStatusBadge from "../src/components/OrderStatusBadge";

const BASE_URL = "http://test.local:8080";

interface RecordedRequest {
  method: string;
  url: string;
  path: string;
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
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      path: new URL(url).pathname,
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

type Entry = string | { pathname: string; state?: unknown };

function renderApp(entry: Entry) {
  const apiClient = createApiClient({ baseUrl: BASE_URL });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <App apiClient={apiClient} />
    </MemoryRouter>,
  );
}

const confirmedOrder: OrderView = {
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

const shippedOrder: OrderView = {
  ...confirmedOrder,
  status: "SHIPPED",
  updatedAt: "2026-01-06T09:00:00.000Z",
  shippedAt: "2026-01-06T09:00:00.000Z",
};

const cancelledOrder: OrderView = {
  ...confirmedOrder,
  status: "CANCELLED",
  updatedAt: "2026-01-06T10:00:00.000Z",
  cancelledAt: "2026-01-06T10:00:00.000Z",
  cancellationReason: "Found a better deal",
};

function stubOrderRoutes(order: OrderView, cancelReply?: StubReply) {
  return stubFetch((request) => {
    if (request.path === "/api/orders/o-1/cancel") {
      if (cancelReply !== undefined) {
        return cancelReply;
      }
      throw new Error("Unexpected cancellation request");
    }
    return json(200, { order });
  });
}

async function fillReason(value: string): Promise<HTMLElement> {
  const field = await screen.findByLabelText("Cancellation reason");
  fireEvent.change(field, { target: { value } });
  return field;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("OrderDetailPage", () => {
  it("renders a confirmed order with status badge, line items, total and creation time", async () => {
    stubOrderRoutes(confirmedOrder);

    renderApp("/orders/o-1");

    expect(await screen.findByRole("heading", { name: "Order o-1" })).toBeInTheDocument();
    expect(screen.getByText("CONFIRMED")).toBeInTheDocument();
    expect(screen.getByText("customer-demo")).toBeInTheDocument();
    expect(screen.getByText("2026-01-05 15:04:05 UTC")).toBeInTheDocument();

    const row = screen.getByRole("row", { name: /Espresso machine/ });
    expect(within(row).getByRole("rowheader", { name: "Espresso machine" })).toBeInTheDocument();
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText(/12\.99/)).toBeInTheDocument();
    expect(within(row).getByText(/25\.98/)).toBeInTheDocument();
    expect(screen.getAllByText(/25\.98/)).toHaveLength(2);

    expect(screen.getByLabelText("Cancellation reason")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeInTheDocument();
  });

  it("gives every order status a distinct visual treatment", () => {
    const statuses = ["CONFIRMED", "SHIPPED", "CANCELLED"] as const;
    render(
      <div>
        {statuses.map((status) => (
          <OrderStatusBadge key={status} status={status} />
        ))}
      </div>,
    );

    const classNames = statuses.map((status) => {
      const badge = screen.getByText(status);
      expect(badge).toHaveAttribute("data-status", status);
      return badge.className;
    });

    expect(classNames.every((className) => className.includes("status-badge"))).toBe(true);
    expect(new Set(classNames).size).toBe(3);
  });

  it("renders a shipped order with its shipping time and without the cancellation form", async () => {
    stubOrderRoutes(shippedOrder);

    renderApp("/orders/o-1");

    expect(await screen.findByText("SHIPPED")).toBeInTheDocument();
    expect(screen.getByText("2026-01-06 09:00:00 UTC")).toBeInTheDocument();
    expect(screen.queryByLabelText("Cancellation reason")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
  });

  it("renders a cancelled order with its reason and cancellation time", async () => {
    stubOrderRoutes(cancelledOrder);

    renderApp("/orders/o-1");

    expect(await screen.findByText("CANCELLED")).toBeInTheDocument();
    expect(screen.getByText("Found a better deal")).toBeInTheDocument();
    expect(screen.getByText("2026-01-06 10:00:00 UTC")).toBeInTheDocument();
    expect(screen.queryByLabelText("Cancellation reason")).not.toBeInTheDocument();
  });

  it("requires a reason and enforces the 200 character limit on the trimmed value", async () => {
    stubOrderRoutes(confirmedOrder);

    renderApp("/orders/o-1");

    const reasonField = await screen.findByLabelText("Cancellation reason");
    const submit = screen.getByRole("button", { name: "Cancel order" });

    expect(submit).toBeDisabled();
    expect(screen.getByText("0 / 200 characters used")).toBeInTheDocument();
    expect(screen.getByText("A cancellation reason is required.")).toBeInTheDocument();
    expect(reasonField).toHaveAttribute("aria-invalid", "true");
    expect(reasonField.getAttribute("aria-describedby")).toContain("cancel-reason-hint");
    expect(reasonField.getAttribute("aria-describedby")).toContain("cancel-reason-error");

    fireEvent.change(reasonField, { target: { value: "    " } });
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeDisabled();
    expect(screen.getByText("A cancellation reason is required.")).toBeInTheDocument();

    fireEvent.change(reasonField, { target: { value: "a".repeat(200) } });
    expect(screen.getByText("200 / 200 characters used")).toBeInTheDocument();
    expect(screen.queryByText(/at most 200 characters/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeEnabled();

    fireEvent.change(reasonField, { target: { value: "a".repeat(201) } });
    expect(screen.getByText("201 / 200 characters used")).toBeInTheDocument();
    expect(screen.getByText(/at most 200 characters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeDisabled();
  });

  it("cancels the order with exactly 200 characters and renders the cancelled state", async () => {
    const requests = stubOrderRoutes(confirmedOrder, json(200, { order: cancelledOrder }));
    const reason = "a".repeat(200);

    renderApp("/orders/o-1");

    await fillReason(reason);
    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));

    expect(await screen.findByText("CANCELLED")).toBeInTheDocument();
    expect(screen.getByText("Found a better deal")).toBeInTheDocument();
    expect(screen.getByText("2026-01-06 10:00:00 UTC")).toBeInTheDocument();
    expect(
      screen.getByText(/Order o-1 was cancelled and a cancellation notification was requested\./),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Cancellation reason")).not.toBeInTheDocument();

    const cancelRequest = requests.find((request) => request.path === "/api/orders/o-1/cancel");
    expect(cancelRequest?.method).toBe("POST");
    expect(cancelRequest?.url).toBe(`${BASE_URL}/api/orders/o-1/cancel`);
    expect(cancelRequest?.headers["content-type"]).toBe("application/json");
    expect(cancelRequest?.body).toEqual({ reason });
  });

  it("submits the trimmed reason typed by the customer", async () => {
    const user = userEvent.setup();
    const requests = stubOrderRoutes(confirmedOrder, json(200, { order: cancelledOrder }));

    renderApp("/orders/o-1");

    const reasonField = await screen.findByLabelText("Cancellation reason");
    await user.type(reasonField, "  Found a better deal  ");
    await user.click(screen.getByRole("button", { name: "Cancel order" }));

    expect(await screen.findByText("CANCELLED")).toBeInTheDocument();
    expect(requests.find((request) => request.path === "/api/orders/o-1/cancel")?.body).toEqual({
      reason: "Found a better deal",
    });
  });

  it("guards against duplicate cancellation submissions while a request is in flight", async () => {
    const gate = createDeferred();
    const requests = stubFetch(async (request) => {
      if (request.path === "/api/orders/o-1/cancel") {
        await gate.promise;
        return json(200, { order: cancelledOrder });
      }
      return json(200, { order: confirmedOrder });
    });

    renderApp("/orders/o-1");

    await fillReason("Found a better deal");
    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));

    const pendingButton = await screen.findByRole("button", { name: "Cancelling order…" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(requests.filter((request) => request.path === "/api/orders/o-1/cancel")).toHaveLength(1);

    gate.resolve();

    expect(await screen.findByText("CANCELLED")).toBeInTheDocument();
    expect(requests.filter((request) => request.path === "/api/orders/o-1/cancel")).toHaveLength(1);
  });

  it("renders a repeat cancellation response identically without a second submission path", async () => {
    stubOrderRoutes(confirmedOrder, json(200, { order: cancelledOrder }));

    renderApp("/orders/o-1");

    await fillReason("Found a better deal");
    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));

    expect(await screen.findByText("CANCELLED")).toBeInTheDocument();
    expect(screen.getAllByText("CANCELLED")).toHaveLength(1);
    expect(screen.getAllByText("Found a better deal")).toHaveLength(1);
    expect(screen.getAllByText("2026-01-06 10:00:00 UTC")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
  });

  it("reports that a shipped order cannot be cancelled", async () => {
    stubOrderRoutes(
      confirmedOrder,
      json(409, {
        error: {
          code: "ORDER_ALREADY_SHIPPED",
          message: "Order o-1 has already been shipped",
          details: {},
        },
      }),
    );

    renderApp("/orders/o-1");

    await fillReason("Found a better deal");
    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));

    expect(await screen.findByText("Order already shipped")).toBeInTheDocument();
    expect(screen.getByText(/Shipped orders cannot be cancelled/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Cancellation reason")).not.toBeInTheDocument();
  });

  it("shows the rejection message when the API refuses the cancellation reason", async () => {
    stubOrderRoutes(
      confirmedOrder,
      json(400, {
        error: {
          code: "INVALID_CANCELLATION_REASON",
          message: "The cancellation reason must be at most 200 characters",
          details: {},
        },
      }),
    );

    renderApp("/orders/o-1");

    await fillReason("Found a better deal");
    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));

    expect(await screen.findByText("The order was not cancelled")).toBeInTheDocument();
    expect(screen.getByText("The cancellation reason must be at most 200 characters")).toBeInTheDocument();
    expect(screen.getByLabelText("Cancellation reason")).toBeInTheDocument();
  });

  it("shows an error banner when the order cannot be loaded", async () => {
    stubFetch(() =>
      json(404, {
        error: { code: "ORDER_NOT_FOUND", message: "Order o-404 was not found" },
      }),
    );

    renderApp("/orders/o-404");

    expect(await screen.findByText("The order could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("Order o-404 was not found")).toBeInTheDocument();
  });

  it("shows the order-created confirmation carried over from the catalog route", async () => {
    stubOrderRoutes(confirmedOrder);

    renderApp({
      pathname: "/orders/o-1",
      state: { notice: "Order o-1 was created and a confirmation notification was requested." },
    });

    expect(
      await screen.findByText(/Order o-1 was created and a confirmation notification was requested\./),
    ).toBeInTheDocument();
  });
});
