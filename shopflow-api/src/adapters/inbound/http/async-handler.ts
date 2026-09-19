import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so a rejected promise is forwarded to the Express error
 * mapper instead of becoming an unhandled rejection.
 */
export function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch((error: unknown) => {
      next(error);
    });
  };
}
