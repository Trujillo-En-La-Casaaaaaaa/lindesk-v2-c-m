import { ProductNotFoundError, ValidationError } from '../../domain/errors';
import { assertInventoryAvailable } from '../../domain/model/product';
import type { Order, OrderItem, OrderView } from '../../domain/model/order';
import { lineTotalCents, orderTotalCents, toOrderView } from '../../domain/model/order';
import type { CreateOrder, CreateOrderInput } from '../ports/inbound/create-order.port';
import type { Clock } from '../ports/outbound/clock.port';
import type { IdGenerator } from '../ports/outbound/id-generator.port';
import type { UnitOfWork } from '../ports/outbound/unit-of-work.port';
import { buildOrderConfirmedNotification, orderConfirmedDedupeKey } from './notification-intent';

export interface ValidatedOrderLine {
  readonly productId: string;
  readonly quantity: number;
}

export interface ValidatedCreateOrderInput {
  readonly customerId: string;
  readonly items: readonly ValidatedOrderLine[];
}

/**
 * Request rules from handoff/API_CONTRACT.md: `customerId` non-empty string, `items`
 * non-empty array, integer `quantity >= 1`, and no duplicate `productId` entries.
 * Every failure writes nothing because it happens before the transaction opens.
 */
export function validateCreateOrderInput(input: unknown): ValidatedCreateOrderInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  const body = input as Record<string, unknown>;

  const rawCustomerId = body['customerId'];
  if (typeof rawCustomerId !== 'string' || rawCustomerId.trim().length === 0) {
    throw new ValidationError('customerId must be a non-empty string', { field: 'customerId' });
  }

  const rawItems: unknown[] = Array.isArray(body['items']) ? (body['items'] as unknown[]) : [];
  if (rawItems.length === 0) {
    throw new ValidationError('items must be a non-empty array', { field: 'items' });
  }

  const items: ValidatedOrderLine[] = [];
  const seenProductIds = new Set<string>();
  for (let index = 0; index < rawItems.length; index += 1) {
    const rawItem = rawItems[index];
    const field = `items[${index}]`;
    if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
      throw new ValidationError(`${field} must be an object`, { field });
    }
    const item = rawItem as Record<string, unknown>;

    const rawProductId = item['productId'];
    if (typeof rawProductId !== 'string' || rawProductId.trim().length === 0) {
      throw new ValidationError(`${field}.productId must be a non-empty string`, { field });
    }
    const productId = rawProductId.trim();

    const rawQuantity = item['quantity'];
    if (typeof rawQuantity !== 'number' || !Number.isInteger(rawQuantity) || rawQuantity < 1) {
      throw new ValidationError(`${field}.quantity must be an integer >= 1`, { field });
    }

    if (seenProductIds.has(productId)) {
      throw new ValidationError(`Duplicate productId ${productId} in items`, {
        field: 'items',
        productId,
      });
    }
    seenProductIds.add(productId);
    items.push({ productId, quantity: rawQuantity });
  }

  return { customerId: rawCustomerId.trim(), items };
}

export interface CreateOrderDeps {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * POST /api/orders — one transaction:
 * lock inventory (ascending product_id) → validate availability → insert order and items →
 * decrement inventory → record exactly one ORDER_CONFIRMED intent → commit.
 * Any failure rolls back, so inventory and outbox stay untouched.
 */
export class CreateOrderUseCase implements CreateOrder {
  constructor(private readonly deps: CreateOrderDeps) {}

  async execute(input: CreateOrderInput): Promise<OrderView> {
    const validated = validateCreateOrderInput(input);
    const orderId = this.deps.ids.next();
    const occurredAt = this.deps.clock.now();

    return this.deps.unitOfWork.run(async (tx) => {
      const productIds = validated.items.map((item) => item.productId);

      const lockedInventory = await tx.inventory.lockByProductIds(productIds);
      const products = await tx.products.findByIds(productIds);
      const productsById = new Map(products.map((product) => [product.id, product]));
      const availableByProductId = new Map(
        lockedInventory.map((row) => [row.productId, row.availableQuantity]),
      );

      const missingProductId = productIds.find((id) => !productsById.has(id));
      if (missingProductId !== undefined) {
        throw new ProductNotFoundError(missingProductId);
      }
      for (const line of validated.items) {
        assertInventoryAvailable(
          line.productId,
          line.quantity,
          availableByProductId.get(line.productId) ?? 0,
        );
      }

      const items: OrderItem[] = [];
      for (const line of validated.items) {
        const product = productsById.get(line.productId);
        if (product === undefined) {
          throw new ProductNotFoundError(line.productId);
        }
        items.push({
          id: this.deps.ids.next(),
          orderId,
          productId: product.id,
          productName: product.name,
          quantity: line.quantity,
          unitPriceCents: product.priceCents,
          lineTotalCents: lineTotalCents(product.priceCents, line.quantity),
        });
      }
      // Deterministic view: items are reported in ascending productId order, matching the
      // `ORDER BY product_id` reads of the persistence adapters.
      items.sort((left, right) => left.productId.localeCompare(right.productId));

      const currency = productsById.get(productIds[0])?.currency ?? 'USD';
      const order: Order = {
        id: orderId,
        customerId: validated.customerId,
        status: 'CONFIRMED',
        totalCents: orderTotalCents(items),
        currency,
        createdAt: occurredAt,
        updatedAt: occurredAt,
        shippedAt: null,
        cancelledAt: null,
        cancellationReason: null,
      };

      await tx.orders.insert(order);
      await tx.orders.insertItems(items);
      for (const line of validated.items) {
        await tx.inventory.decrement(line.productId, line.quantity);
      }
      await tx.outbox.enqueue({
        id: this.deps.ids.next(),
        dedupeKey: orderConfirmedDedupeKey(orderId),
        type: 'ORDER_CONFIRMED',
        orderId,
        payload: buildOrderConfirmedNotification(order, occurredAt),
        createdAt: occurredAt,
      });

      return toOrderView(order, items);
    });
  }
}
