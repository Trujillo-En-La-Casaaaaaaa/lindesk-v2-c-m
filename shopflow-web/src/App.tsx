import { createContext, useContext } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { apiClient as defaultApiClient, type ShopFlowApiClient } from "./api/client";
import AdminOrdersPage from "./pages/AdminOrdersPage";
import CatalogPage from "./pages/CatalogPage";
import OrderDetailPage from "./pages/OrderDetailPage";

/** Provides the typed API client to every screen of the application. */
const ApiClientContext = createContext<ShopFlowApiClient>(defaultApiClient);

export function useApiClient(): ShopFlowApiClient {
  return useContext(ApiClientContext);
}

export interface AppProps {
  /** Optional client override; the shell owns the instance used by the screens. */
  apiClient?: ShopFlowApiClient;
}

/**
 * Application shell: layout, navigation, API client provider and the three
 * ShopFlow routes (catalog, order detail, admin orders).
 */
export default function App({ apiClient }: AppProps = {}) {
  const client = apiClient ?? defaultApiClient;

  return (
    <ApiClientContext.Provider value={client}>
      <div className="app-shell">
        <header className="app-header">
          <p className="app-brand">ShopFlow</p>
          <nav className="app-nav" aria-label="Primary">
            <NavLink to="/" end className={({ isActive }) => navLinkClass(isActive)}>
              Catalog
            </NavLink>
            <NavLink to="/admin" className={({ isActive }) => navLinkClass(isActive)}>
              Admin orders
            </NavLink>
          </nav>
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<CatalogPage />} />
            <Route path="/orders/:orderId" element={<OrderDetailPage />} />
            <Route path="/admin" element={<AdminOrdersPage />} />
          </Routes>
        </main>
      </div>
    </ApiClientContext.Provider>
  );
}

function navLinkClass(isActive: boolean): string {
  return isActive ? "app-nav-link app-nav-link-active" : "app-nav-link";
}
