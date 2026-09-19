import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import type { Logger } from '../../../application/ports/outbound/logger.port';
import { DomainError, type DomainErrorCode } from '../../../domain/errors';

/** Frozen error envelope: `{"error":{"code":"...","message":"...","details":{...}}}`. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

export interface ErrorResponse {
  readonly status: number;
  readonly body: ErrorEnvelope;
}

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_CANCELLATION_REASON: 400,
  PRODUCT_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  NOT_FOUND: 404,
  INSUFFICIENT_INVENTORY: 409,
  ORDER_ALREADY_SHIPPED: 409,
  ORDER_ALREADY_CANCELLED: 409,
  INTERNAL_ERROR: 500,
};

export function statusForDomainErrorCode(code: DomainErrorCode): number {
  return STATUS_BY_CODE[code];
}

function isMalformedRequestError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = error as Error & {
    type?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  if (
    candidate.type === 'entity.parse.failed' ||
    candidate.type === 'entity.too.large' ||
    candidate.type === 'charset.unsupported' ||
    candidate.type === 'encoding.unsupported'
  ) {
    return true;
  }
  return candidate.status === 400 || candidate.statusCode === 400;
}

/**
 * Maps any thrown value to the frozen error envelope.
 *
 * Unexpected failures become `500 INTERNAL_ERROR` with a generic message: SQL text, driver
 * errors, and stack traces are logged server-side only and never returned to a client.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof DomainError) {
    return {
      status: STATUS_BY_CODE[error.code],
      body: {
        error: { code: error.code, message: error.message, details: error.details },
      },
    };
  }
  if (isMalformedRequestError(error)) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Malformed request body or query',
          details: {},
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: {},
      },
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Express error middleware producing the envelope and logging server-side detail. */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const response = toErrorResponse(error);
    const meta = {
      method: req.method,
      path: req.originalUrl,
      status: response.status,
      code: response.body.error.code,
      error: describeError(error),
    };
    if (response.status >= 500) {
      logger.error('request failed', meta);
    } else {
      logger.debug('request rejected', meta);
    }
    res.status(response.status).json(response.body);
  };
}
