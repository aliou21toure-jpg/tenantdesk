import { randomUUID } from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type pg from "pg";
import type { Config } from "../config.js";
import { withTransaction, type Queryable } from "../db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { LoginSchema, RefreshSchema, RegisterSchema } from "../lib/schemas.js";
import {
  generateRefreshToken,
  getDummyHash,
  hashPassword,
  hashToken,
  signAccessToken,
  verifyPassword,
} from "../lib/tokens.js";

type AuthConfig = Pick<Config, "JWT_SECRET" | "ACCESS_TOKEN_TTL_SECONDS" | "REFRESH_TOKEN_TTL_DAYS">;

export function authRouter(pool: pg.Pool, config: AuthConfig, opts: { rateLimit?: boolean } = {}): Router {
  const router = Router();

  // Slow down credential stuffing / brute force on login and register.
  if (opts.rateLimit !== false) {
    router.use(rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false }));
  }

  async function issueTokens(db: Queryable, userId: string, familyId: string = randomUUID()) {
    const refresh = generateRefreshToken();
    await db.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [userId, familyId, hashToken(refresh), config.REFRESH_TOKEN_TTL_DAYS],
    );
    return {
      access_token: signAccessToken(userId, config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS),
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: config.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /** Create a user and their first organization (as owner) in one transaction. */
  router.post("/register", async (req, res) => {
    const input = RegisterSchema.parse(req.body);
    const passwordHash = await hashPassword(input.password);

    const result = await withTransaction(pool, async (tx) => {
      const existing = await tx.query("SELECT 1 FROM users WHERE lower(email) = $1", [input.email]);
      if (existing.rowCount) throw new HttpError(409, "An account with this email already exists", "email_taken");

      const user = (
        await tx.query<{ id: string }>(
          "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
          [input.email, input.name, passwordHash],
        )
      ).rows[0]!;
      const org = (
        await tx.query<{ id: string }>("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [
          input.organization,
        ])
      ).rows[0]!;
      await tx.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')", [org.id, user.id]);

      await tx.query("SELECT set_config('app.current_org', $1, true)", [org.id]);
      await audit(tx, { orgId: org.id, actorId: user.id, action: "org.created", entityType: "organization", entityId: org.id });

      return { user_id: user.id, org_id: org.id, ...(await issueTokens(tx, user.id)) };
    });
    res.status(201).json(result);
  });

  router.post("/login", async (req, res) => {
    const { email, password } = LoginSchema.parse(req.body);
    const { rows } = await pool.query<{ id: string; password_hash: string }>(
      "SELECT id, password_hash FROM users WHERE lower(email) = $1",
      [email],
    );
    const user = rows[0];
    // Always run one Argon2 verification so response time does not reveal whether the email exists.
    const ok = await verifyPassword(user?.password_hash ?? (await getDummyHash()), password);
    if (!user || !ok) throw new HttpError(401, "Invalid email or password", "invalid_credentials");

    res.json(await issueTokens(pool, user.id));
  });

  /**
   * Refresh-token rotation with reuse detection:
   * each refresh token works once. If a used token is presented again, it was
   * probably stolen — revoke the whole token family and force a new login.
   */
  router.post("/refresh", async (req, res) => {
    const { refresh_token } = RefreshSchema.parse(req.body);
    const tokenHash = hashToken(refresh_token);

    const outcome = await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{
        id: string; user_id: string; family_id: string; expired: boolean; used_at: Date | null; revoked_at: Date | null;
      }>(
        `SELECT id, user_id, family_id, expires_at < now() AS expired, used_at, revoked_at
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      const token = rows[0];
      if (!token || token.revoked_at || token.expired) return { ok: false as const };

      if (token.used_at) {
        await tx.query("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [
          token.family_id,
        ]);
        return { ok: false as const, reuse: true };
      }

      await tx.query("UPDATE refresh_tokens SET used_at = now() WHERE id = $1", [token.id]);
      return { ok: true as const, tokens: await issueTokens(tx, token.user_id, token.family_id) };
    });

    if (!outcome.ok) throw new HttpError(401, "Invalid refresh token", "invalid_refresh_token");
    res.json(outcome.tokens);
  });

  /** Revoke the whole session (token family). Idempotent: always 204. */
  router.post("/logout", async (req, res) => {
    const { refresh_token } = RefreshSchema.parse(req.body);
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
      [hashToken(refresh_token)],
    );
    res.status(204).end();
  });

  return router;
}
