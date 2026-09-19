import type { ReactNode } from "react";

export interface ErrorBannerProps {
  title?: string;
  message: string;
  /** Optional extra lines, e.g. the details of an API error. */
  details?: ReactNode;
}

/**
 * Inline error banner used by every screen for API failures and rejection
 * messages. Announced immediately because it carries actionable information.
 */
export default function ErrorBanner({ title = "Something went wrong", message, details }: ErrorBannerProps) {
  return (
    <div className="error-banner" role="alert">
      <p className="error-banner-title">{title}</p>
      <p className="error-banner-message">{message}</p>
      {details === undefined ? null : <div className="error-banner-details">{details}</div>}
    </div>
  );
}
