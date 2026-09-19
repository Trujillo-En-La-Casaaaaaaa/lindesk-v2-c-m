import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApiClient } from "../App";
import {
  describeApiError,
  getCustomerId,
  isApiError,
  readInsufficientInventoryDetails,
} from "../api/client";
import { ERROR_CODES, type ProductView } from "../api/types";
import ErrorBanner from "../components/ErrorBanner";
import ProductCard from "../components/ProductCard";

type LoadState = "loading" | "ready" | "error";

/**
 * Catalog screen: shows the products reported by the API with their live
 * availability and creates a single-line order per product.
 */
export default function CatalogPage() {
  const api = useApiClient();
  const navigate = useNavigate();

  const [products, setProducts] = useState<ProductView[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [inventoryWarning, setInventoryWarning] = useState<string | null>(null);
  const [submittingProductId, setSubmittingProductId] = useState<string | null>(null);

  const loadProducts = useCallback(async (): Promise<void> => {
    setLoadState("loading");
    setLoadError(null);
    try {
      const loaded = await api.listProducts();
      setProducts(loaded);
      setLoadState("ready");
    } catch (error) {
      setProducts([]);
      setLoadError(describeApiError(error));
      setLoadState("error");
    }
  }, [api]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const createOrder = useCallback(
    async (product: ProductView, quantity: number): Promise<void> => {
      setSubmittingProductId(product.id);
      setOrderError(null);
      setInventoryWarning(null);
      try {
        const order = await api.createOrder({
          customerId: getCustomerId(),
          items: [{ productId: product.id, quantity }],
        });
        navigate(`/orders/${encodeURIComponent(order.id)}`, {
          state: {
            notice: `Order ${order.id} was created and a confirmation notification was requested.`,
          },
        });
      } catch (error) {
        if (isApiError(error) && error.code === ERROR_CODES.insufficientInventory) {
          const details = readInsufficientInventoryDetails(error.details);
          const productName =
            details === null
              ? null
              : details.productId === product.id
                ? product.name
                : (products.find((candidate) => candidate.id === details.productId)?.name ?? details.productId);
          setInventoryWarning(
            details === null || productName === null
              ? error.message
              : `Not enough inventory for ${productName}: only ${details.available} available, ${details.requested} requested. The catalog has been refreshed.`,
          );
          await loadProducts();
        } else {
          setOrderError(describeApiError(error));
        }
      } finally {
        setSubmittingProductId(null);
      }
    },
    [api, loadProducts, navigate, products],
  );

  return (
    <section className="page" aria-labelledby="catalog-heading">
      <h1 className="page-heading" id="catalog-heading">
        Product catalog
      </h1>

      {orderError === null ? null : <ErrorBanner title="The order was not created" message={orderError} />}
      {inventoryWarning === null ? null : (
        <ErrorBanner title="Insufficient inventory" message={inventoryWarning} />
      )}

      {loadState === "loading" ? (
        <p className="state-message" role="status">
          Loading products…
        </p>
      ) : null}

      {loadState === "error" && loadError !== null ? (
        <ErrorBanner title="The catalog could not be loaded" message={loadError} />
      ) : null}

      {loadState === "ready" && products.length === 0 ? (
        <p className="state-message">No products are available at the moment.</p>
      ) : null}

      {loadState === "ready" && products.length > 0 ? (
        <ul className="product-grid">
          {products.map((product) => (
            <li className="product-grid-item" key={product.id}>
              <ProductCard
                product={product}
                submitting={submittingProductId === product.id}
                onCreateOrder={createOrder}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
