import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import jwt from "jsonwebtoken";

/* ---------- passwords ---------- */

// Argon2id: memory-hard, the current OWASP recommendation for password storage.
export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);

// A real hash of a random value, used to keep login timing similar when the
// email does not exist (prevents account enumeration by timing).
let dummyHash: Promise<string> | undefined;
export const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));

/* ---------- access tokens (JWT, short-lived) ---------- */

export interface AccessClaims {
  sub: string; // user id
}

export function signAccessToken(userId: string, secret: string, ttlSeconds: number): string {
  return jwt.sign({}, secret, {
    algorithm: "HS256",
    subject: userId,
    expiresIn: ttlSeconds,
    issuer: "tenantdesk",
    audience: "tenantdesk-api",
  });
}

export function verifyAccessToken(token: string, secret: string): AccessClaims {
  // Pinning the algorithm blocks "alg: none" and algorithm-confusion attacks.
  const payload = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    issuer: "tenantdesk",
    audience: "tenantdesk-api",
  });
  if (typeof payload === "string" || !payload.sub) throw new Error("invalid token payload");
  return { sub: payload.sub };
}

/* ---------- refresh tokens (opaque, long-lived, rotated) ---------- */

export const generateRefreshToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
