import request from "supertest";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type App, addMember, auth, makeTestApp, registerUser, resetDb, type TestUser } from "./helpers.js";

let app: App;
let pool: pg.Pool;
beforeAll(() => ({ app, pool } = makeTestApp()));
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

let owner: TestUser;
let clientId: string;
const base = () => `/orgs/${owner.orgId}/invoices`;

beforeEach(async () => {
  owner = await registerUser(app, "owner");
  clientId = (await request(app).post(`/orgs/${owner.orgId}/clients`).set(auth(owner)).send({ name: "Acme" })).body.id;
});

const items = [
  { description: "Security audit", quantity: 2, unit_price_cents: 150_000 },
  { description: "Report", quantity: 1, unit_price_cents: 49_999 },
];

describe("invoices", () => {
  it("computes the total server-side in integer cents", async () => {
    const res = await request(app).post(base()).set(auth(owner)).send({ client_id: clientId, items });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: 1, status: "draft", total_cents: 349_999, currency: "CAD" });
  });

  it("rejects a client-supplied total and fractional cents", async () => {
    const withTotal = await request(app).post(base()).set(auth(owner)).send({ client_id: clientId, items, total_cents: 1 });
    expect(withTotal.status).toBe(400);
    const fractional = await request(app).post(base()).set(auth(owner))
      .send({ client_id: clientId, items: [{ description: "x", quantity: 1, unit_price_cents: 10.5 }] });
    expect(fractional.status).toBe(400);
  });

  it("numbers invoices sequentially per organization, even under concurrency", async () => {
    await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(base()).set(auth(owner)).send({ client_id: clientId, items })),
    );
    const res = await request(app).get(base()).set(auth(owner));
    expect(res.body.items.map((i: { number: number }) => i.number)).toEqual([5, 4, 3, 2, 1]);

    const other = await registerUser(app, "other");
    const otherClient = (await request(app).post(`/orgs/${other.orgId}/clients`).set(auth(other)).send({ name: "B" })).body.id;
    const first = await request(app).post(`/orgs/${other.orgId}/invoices`).set(auth(other)).send({ client_id: otherClient, items });
    expect(first.body.number).toBe(1);
  });

  it("returns the invoice with its line items", async () => {
    const created = (await request(app).post(base()).set(auth(owner)).send({ client_id: clientId, items })).body;
    const res = await request(app).get(`${base()}/${created.id}`).set(auth(owner));
    expect(res.body.items).toHaveLength(2);
  });

  it("follows the status workflow draft → sent → paid", async () => {
    const inv = (await request(app).post(base()).set(auth(owner)).send({ client_id: clientId, items })).body;
    const url = `${base()}/${inv.id}/status`;
    expect((await request(app).post(url).set(auth(owner)).send({ status: "paid" })).status).toBe(409);
    expect((await request(app).post(url).set(auth(owner)).send({ status: "sent" })).body.status).toBe("sent");
    expect((await request(app).post(url).set(auth(owner)).send({ status: "paid" })).body.status).toBe("paid");
    expect((await request(app).post(url).set(auth(owner)).send({ status: "void" })).status).toBe(409);
  });

  it("members can create invoices but not mark them paid", async () => {
    const member = await addMember(app, owner, "member");
    const inv = await request(app).post(base()).set(auth(member)).send({ client_id: clientId, items });
    expect(inv.status).toBe(201);
    const res = await request(app).post(`${base()}/${inv.body.id}/status`).set(auth(member)).send({ status: "sent" });
    expect(res.status).toBe(403);
  });

  it("refuses to delete a client that has invoices", async () => {
    await request(app).post(base()).set(auth(owner)).send({ client_id: clientId, items });
    const res = await request(app).delete(`/orgs/${owner.orgId}/clients/${clientId}`).set(auth(owner));
    expect(res.status).toBe(409);
  });

  it("records invoice actions in the audit log", async () => {
    const inv = (await request(app).post(base()).set(auth(owner)).send({ client_id: clientId, items })).body;
    await request(app).post(`${base()}/${inv.id}/status`).set(auth(owner)).send({ status: "sent" });
    const log = await request(app).get(`/orgs/${owner.orgId}/audit`).set(auth(owner));
    expect(log.body.items.map((e: { action: string }) => e.action).slice(0, 2)).toEqual(["invoice.sent", "invoice.created"]);
  });
});
