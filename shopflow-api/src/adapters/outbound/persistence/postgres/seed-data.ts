/**
 * Deterministic seed dataset, copied from handoff/SEED_DATA.md.
 *
 * shopflow-infra asserts this table exactly (ids, sku, priceCents, availableQuantity), so any
 * change here must be mirrored there.
 */
export interface SeedProduct {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly availableQuantity: number;
}

/** Fixed creation timestamp so repeated seeds produce byte-stable rows. */
export const SEED_CREATED_AT = '2026-01-01T00:00:00.000Z';

export const SEED_PRODUCTS: readonly SeedProduct[] = [
  {
    id: 'prod-espresso-machine',
    sku: 'SF-ESP-001',
    name: 'Espresso Machine',
    description: 'Semi-automatic espresso machine with steam wand.',
    priceCents: 24999,
    currency: 'USD',
    availableQuantity: 5,
  },
  {
    id: 'prod-burr-grinder',
    sku: 'SF-GRD-002',
    name: 'Burr Coffee Grinder',
    description: 'Conical burr grinder with 15 grind settings.',
    priceCents: 8999,
    currency: 'USD',
    availableQuantity: 10,
  },
  {
    id: 'prod-milk-pitcher',
    sku: 'SF-MLK-003',
    name: 'Milk Pitcher',
    description: 'Stainless steel 600 ml frothing pitcher.',
    priceCents: 1999,
    currency: 'USD',
    availableQuantity: 25,
  },
  {
    id: 'prod-coffee-beans-1kg',
    sku: 'SF-BEA-004',
    name: 'Single Origin Coffee Beans 1 kg',
    description: 'Medium roast single origin beans, whole bean.',
    priceCents: 3499,
    currency: 'USD',
    availableQuantity: 40,
  },
];
