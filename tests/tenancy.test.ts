import request from "supertest";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "../src/db.js";
import { type App, auth, makeTestApp, registerUser, resetDb, type TestUser } from "./helpers.js";

let app: App;
let pool: pg.Pool;
beforeAll(() => ({ app, pool } = makeTestApp()));
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function createClient(u: TestUser, name: string) {
  const res = await request(app).post(`/orgs/${u.orgId}/clients`).set(auth(u)).send({ name });
  expect(res.status).toBe(201);
  return res.body;
}

describe("tenant isolation (API level)", () => {
  let alice: TestUser;
  let bob: TestUser;
  beforeEach(async () => {
    alice = await registerUser(app, "alice");
    bob = await registerUser(app, "bob");
  });

  it("each tenant only lists its own clients", async () => {
    await createClient(alice, "Alice Client");
    await createClient(bob, "Bob Client");
    const res = await request(app).get(`/orgs/${alice.orgId}/clients`).set(auth(alice));
    expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(["Alice Client"]);
  });

  it("returns 404 (not 403) when accessing another tenant's organization", async () => {
    const res = await request(app).get(`/orgs/${bob.orgId}/clients`).set(auth(alice));
    expect(res.status).toBe(404);
  });

  it("cannot read another tenant's client even with a valid client id", async () => {
    const bobClient = await createClient(bob, "Secret");
    const res = await request(app).get(`/orgs/${alice.orgId}/clients/${bobClient.id}`).set(auth(alice));
    expect(res.status).toBe(404);
  });

  it("cannot invoice another tenant's client", async () => {
    const bobClient = await createClient(bob, "Secret");
    const res = await request(app)
      .post(`/orgs/${alice.orgId}/invoices`)
      .set(auth(alice))
      .send({ client_id: bobClient.id, items: [{ description: "x", quantity: 1, unit_price_cents: 100 }] });
    expect(res.status).toBe(404);
  });
});

describe("tenant isolation (database level — Row-Level Security)", () => {
  it("hides every row when no tenant is set (fails closed)", async () => {
    const alice = await registerUser(app, "alice");
    await createClient(alice, "Alice Client");
    const { rows } = await pool.query("SELECT * FROM clients");
    expect(rows).toHaveLength(0);
  });

  it("only shows the current tenant's rows, even without a WHERE clause", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    await createClient(alice, "A");
    await createClient(bob, "B");
    const rows = await withTenant(pool, alice.orgId, async (tx) => (await tx.query("SELECT name FROM clients")).rows);
    expect(rows).toEqual([{ name: "A" }]);
  });

  it("blocks inserting a row for another tenant", async () => {
    const alice = await registerUser(app, "alice");
    const bob = await registerUser(app, "bob");
    await expect(
      withTenant(pool, alice.orgId, (tx) => tx.query("INSERT INTO clients (org_id, name) VALUES ($1, 'x')", [bob.orgId])),
    ).rejects.toThrow(/row-level security/);
  });

  it("makes the audit log append-only", async () => {
    const alice = await registerUser(app, "alice");
    await expect(
      withTenant(pool, alice.orgId, (tx) => tx.query("DELETE FROM audit_logs")),
    ).rejects.toThrow(/append-only/);
  });
});
