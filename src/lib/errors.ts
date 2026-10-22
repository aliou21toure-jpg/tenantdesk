import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export const notFoundHandler: RequestHandler = (req, _res, next) =>
  next(new HttpError(404, `Route ${req.method} ${req.path} not found`, "not_found"));

/** PostgreSQL error codes we translate into client errors. */
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "validation_failed",
        message: "Validation failed",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code ?? "error", message: err.message } });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON" } });
    return;
  }
  if (err?.code === PG_UNIQUE_VIOLATION) {
    res.status(409).json({ error: { code: "conflict", message: "Resource already exists" } });
    return;
  }
  if (err?.code === PG_FOREIGN_KEY_VIOLATION) {
    res.status(409).json({ error: { code: "conflict", message: "Resource is referenced by other records" } });
    return;
  }
  req.log?.error({ err }, "unhandled error");
  res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
};
