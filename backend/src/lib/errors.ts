import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Express 4 does not catch rejected promises from async handlers: the request
 * is simply never answered — no response, no log line, no released socket.
 * Every route in this app is wrapped in asyncRoute() so a throw becomes a
 * response instead of a hang.
 */
export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** An error with an intended HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra: Record<string, unknown> = {}
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

export const badRequest = (code: string, msg?: string) => new HttpError(400, code, msg);
export const unauthorized = (code = "not_authenticated") => new HttpError(401, code);
export const forbidden = (code = "forbidden") => new HttpError(403, code);
export const notFound = (code = "not_found") => new HttpError(404, code);
export const paymentRequired = (code: string, extra: Record<string, unknown> = {}) =>
  new HttpError(402, code, undefined, extra);

/** Terminal error middleware. Must be registered last, after all routes. */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;

  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, ...err.extra });
  }

  // Prisma unique-constraint violation. A real bug, but answer the client.
  if (err?.code === "P2002") {
    console.error("[error] unique constraint violated:", err.meta);
    return res.status(409).json({ error: "conflict" });
  }

  console.error("[error]", err?.stack || err);
  return res.status(500).json({ error: "internal_error" });
}
