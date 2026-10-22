import jwt from "jsonwebtoken";
import request from "supertest";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type App, makeTestApp, registerUser, resetDb } from "./helpers.js";

let app: App;
let pool: pg.Pool;
beforeAll(() => ({ app, pool } = makeTestApp()));
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

describe("registration", () => {
  it("creates a user, an organization and an owner membership", async () => {
    const u = await registerUser(app, "ana");
    const me = await request(app).get("/me").set("Authorization", `Bearer ${u.token}`);
    expect(me.status).toBe(200);
    expect(me.body.organizations).toEqual([{ id: u.orgId, name: "ana's company", role: "owner" }]);
    expect(me.body).not.toHaveProperty("password_hash");
  });

  it("stores the password hashed with Argon2id", async () => {
    const u = await registerUser(app);
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [u.userId]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it("rejects duplicate emails case-insensitively", async () => {
    const u = await registerUser(app);
    const res = await request(app).post("/auth/register").send({
      email: u.email.toUpperCase(), name: "x", password: "another long password", organization: "x",
    });
    expect(res.status).toBe(409);
  });

  it("rejects short passwords", async () => {
    const res = await request(app).post("/auth/register").send({
      email: "a@b.co", name: "a", password: "short", organization: "x",
    });
    expect(res.status).toBe(400);
  });
});

describe("login", () => {
  it("returns tokens for valid credentials", async () => {
    const u = await registerUser(app);
    const res = await request(app).post("/auth/login").send({ email: u.email, password: "correct horse battery staple" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_type: "Bearer", expires_in: 900 });
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const u = await registerUser(app);
    const wrong = await request(app).post("/auth/login").send({ email: u.email, password: "nope nope nope" });
    const unknown = await request(app).post("/auth/login").send({ email: "ghost@example.com", password: "nope nope nope" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });
});

describe("access tokens", () => {
  it("rejects requests without a token", async () => {
    expect((await request(app).get("/me")).status).toBe(401);
  });

  it("rejects a token signed with another secret", async () => {
    const forged = jwt.sign({}, "attacker-secret-attacker-secret-1234", {
      subject: "00000000-0000-4000-8000-000000000000", issuer: "tenantdesk", audience: "tenantdesk-api",
    });
    expect((await request(app).get("/me").set("Authorization", `Bearer ${forged}`)).status).toBe(401);
  });

  it("rejects an unsigned 'alg: none' token", async () => {
    const none = jwt.sign({ sub: "x", iss: "tenantdesk", aud: "tenantdesk-api" }, "", { algorithm: "none" });
    expect((await request(app).get("/me").set("Authorization", `Bearer ${none}`)).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const u = await registerUser(app);
    const expired = jwt.sign({}, process.env.JWT_SECRET!, {
      subject: u.userId, issuer: "tenantdesk", audience: "tenantdesk-api", expiresIn: -10,
    });
    expect((await request(app).get("/me").set("Authorization", `Bearer ${expired}`)).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("issues a new pair and invalidates the old refresh token", async () => {
    const u = await registerUser(app);
    const first = await request(app).post("/auth/refresh").send({ refresh_token: u.refresh });
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(u.refresh);
    const me = await request(app).get("/me").set("Authorization", `Bearer ${first.body.access_token}`);
    expect(me.status).toBe(200);
  });

  it("detects reuse of an old token and revokes the whole session", async () => {
    const u = await registerUser(app);
    const rotated = await request(app).post("/auth/refresh").send({ refresh_token: u.refresh });
    // Attacker replays the original (already used) token...
    const replay = await request(app).post("/auth/refresh").send({ refresh_token: u.refresh });
    expect(replay.status).toBe(401);
    // ...and the legitimate user's newer token is revoked too.
    const legit = await request(app).post("/auth/refresh").send({ refresh_token: rotated.body.refresh_token });
    expect(legit.status).toBe(401);
  });

  it("stores refresh tokens hashed", async () => {
    const u = await registerUser(app);
    const { rows } = await pool.query("SELECT token_hash FROM refresh_tokens");
    expect(rows.map((r) => r.token_hash)).not.toContain(u.refresh);
  });

  it("logout revokes the session", async () => {
    const u = await registerUser(app);
    expect((await request(app).post("/auth/logout").send({ refresh_token: u.refresh })).status).toBe(204);
    expect((await request(app).post("/auth/refresh").send({ refresh_token: u.refresh })).status).toBe(401);
  });
});
