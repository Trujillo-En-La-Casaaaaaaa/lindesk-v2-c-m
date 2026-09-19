import { useState, type FormEvent } from "react";
import { CANCELLATION_REASON_MAX_LENGTH } from "../api/types";
import ErrorBanner from "./ErrorBanner";

export interface CancelOrderFormProps {
  /** True while the cancellation request is in flight; blocks duplicate submits. */
  submitting: boolean;
  /** Rejection reported by the API (e.g. `INVALID_CANCELLATION_REASON`). */
  errorMessage?: string | null;
  onCancel: (reason: string) => void;
}

const REASON_FIELD_ID = "cancel-reason";
const REASON_HINT_ID = "cancel-reason-hint";
const REASON_ERROR_ID = "cancel-reason-error";

/**
 * Customer cancellation form. Client-side validation mirrors the backend rule
 * exactly: the trimmed reason is required and must be at most 200 characters.
 */
export default function CancelOrderForm({ submitting, errorMessage = null, onCancel }: CancelOrderFormProps) {
  const [reason, setReason] = useState("");

  const trimmedReason = reason.trim();
  const usedCharacters = trimmedReason.length;
  const isEmpty = usedCharacters === 0;
  const isTooLong = usedCharacters > CANCELLATION_REASON_MAX_LENGTH;
  const isValid = !isEmpty && !isTooLong;

  const validationMessage = isEmpty
    ? "A cancellation reason is required."
    : isTooLong
      ? `A cancellation reason must be at most ${CANCELLATION_REASON_MAX_LENGTH} characters (currently ${usedCharacters}).`
      : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!isValid || submitting) {
      return;
    }
    onCancel(trimmedReason);
  }

  return (
    <form className="cancel-order-form" onSubmit={handleSubmit} noValidate>
      <h2 className="form-heading">Cancel this order</h2>
      <label className="field-label" htmlFor={REASON_FIELD_ID}>
        Cancellation reason
      </label>
      <textarea
        id={REASON_FIELD_ID}
        className="field-textarea"
        name="reason"
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        disabled={submitting}
        aria-invalid={!isValid}
        aria-describedby={validationMessage === null ? REASON_HINT_ID : `${REASON_HINT_ID} ${REASON_ERROR_ID}`}
        required
      />
      <p className="field-hint" id={REASON_HINT_ID}>
        {usedCharacters} / {CANCELLATION_REASON_MAX_LENGTH} characters used
      </p>
      {validationMessage === null ? null : (
        <p className="field-error" id={REASON_ERROR_ID} aria-live="polite">
          {validationMessage}
        </p>
      )}
      {errorMessage === null ? null : (
        <ErrorBanner title="The order was not cancelled" message={errorMessage} />
      )}
      <button className="button" type="submit" disabled={!isValid || submitting}>
        {submitting ? "Cancelling order…" : "Cancel order"}
      </button>
    </form>
  );
}
