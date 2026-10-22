import request from "supertest";
import type pg from "pg";
import { createApp } from "../src/app.js";
import { createPool } from "../src/db.js";

export function makeTestApp() {
  const pool = createPool(process.env.DATABASE_URL!);
  const app = createApp({
    pool,
    rateLimit: false,
    config: {
      JWT_SECRET: process.env.JWT_SECRET!,
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 14,
      LOG_LEVEL: "silent",
    },
  });
  return { app, pool };
}

export async function resetDb(pool: pg.Pool): Promise<void> {
  // TRUNCATE skips row-level triggers, so it works on the append-only audit log.
  await pool.query(
    "TRUNCATE audit_logs, invoice_items, invoices, clients, refresh_tokens, memberships, organizations, users",
  );
}

export type App = ReturnType<typeof makeTestApp>["app"];

export interface TestUser {
  userId: string;
  orgId: string;
  token: string;
  refresh: string;
  email: string;
}

let counter = 0;

/** Register a fresh user who owns a fresh organization. */
export async function registerUser(app: App, name = "user"): Promise<TestUser> {
  const email = `${name}${++counter}@example.com`;
  const res = await request(app).post("/auth/register").send({
    email,
    name,
    password: "correct horse battery staple",
    organization: `${name}'s company`,
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { userId: res.body.user_id, orgId: res.body.org_id, token: res.body.access_token, refresh: res.body.refresh_token, email };
}

/** Register a user and add them to `orgId` with `role`, acting as `owner`. */
export async function addMember(app: App, owner: TestUser, role: string, name = role): Promise<TestUser> {
  const u = await registerUser(app, name);
  const res = await request(app)
    .post(`/orgs/${owner.orgId}/members`)
    .set("Authorization", `Bearer ${owner.token}`)
    .send({ email: u.email, role });
  if (res.status !== 201) throw new Error(`addMember failed: ${JSON.stringify(res.body)}`);
  return { ...u, orgId: owner.orgId };
}

export const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
