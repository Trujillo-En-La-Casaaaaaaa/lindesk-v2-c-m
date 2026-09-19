/**
 * Display formatting shared by the screens. Formatting is presentation only:
 * no business rule of the ShopFlow domain is re-implemented here.
 */

const currencyFormatters = new Map<string, Intl.NumberFormat>();

/** Formats a minor-unit amount using the currency reported by the API. */
export function formatMoney(amountCents: number, currency: string): string {
  const amount = amountCents / 100;
  try {
    let formatter = currencyFormatters.get(currency);
    if (formatter === undefined) {
      formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
      currencyFormatters.set(currency, formatter);
    }
    return formatter.format(amount);
  } catch {
    // Unknown currency code: fall back to an unambiguous plain rendering.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Formats an API timestamp (ISO-8601 UTC) as a stable, explicit UTC string. */
export function formatDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
