import express, { type Express } from "express";
import helmet from "helmet";
import type pg from "pg";
import { pinoHttp } from "pino-http";
import type { Config } from "./config.js";
import { errorHandler, notFoundHandler } from "./lib/errors.js";
import { authenticate, requireMembership } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { clientsRouter } from "./routes/clients.js";
import { invoicesRouter } from "./routes/invoices.js";
import { orgsRouter } from "./routes/orgs.js";

export interface AppOptions {
  pool: pg.Pool;
  config: Pick<Config, "JWT_SECRET" | "ACCESS_TOKEN_TTL_SECONDS" | "REFRESH_TOKEN_TTL_DAYS" | "LOG_LEVEL">;
  rateLimit?: boolean;
}

export function createApp({ pool, config, rateLimit = true }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // correct client IPs for rate limiting behind one proxy/load balancer
  app.use(helmet());
  app.use(pinoHttp({ level: config.LOG_LEVEL, redact: ["req.headers.authorization"] }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use("/auth", authRouter(pool, config, { rateLimit }));

  // Everything below requires a valid access token.
  app.use(authenticate(config.JWT_SECRET));
  app.use(orgsRouter(pool));
  app.use("/orgs/:orgId/clients", requireMembership(pool), clientsRouter(pool));
  app.use("/orgs/:orgId/invoices", requireMembership(pool), invoicesRouter(pool));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
