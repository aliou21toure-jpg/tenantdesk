import request from "supertest";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { can, ROLES } from "../src/lib/permissions.js";
import { type App, addMember, auth, makeTestApp, registerUser, resetDb, type TestUser } from "./helpers.js";

let app: App;
let pool: pg.Pool;
beforeAll(() => ({ app, pool } = makeTestApp()));
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

describe("permission matrix (unit)", () => {
  it("every role can read", () => {
    for (const r of ROLES) expect(can(r, "clients:read")).toBe(true);
  });
  it("viewers cannot write", () => {
    expect(can("viewer", "clients:write")).toBe(false);
    expect(can("viewer", "invoices:write")).toBe(false);
  });
  it("only owners change roles", () => {
    expect(ROLES.filter((r) => can(r, "members:change_role"))).toEqual(["owner"]);
  });
  it("members cannot delete clients or read the audit log", () => {
    expect(can("member", "clients:delete")).toBe(false);
    expect(can("member", "audit:read")).toBe(false);
  });
});

describe("roles enforced by the API", () => {
  let owner: TestUser, admin: TestUser, member: TestUser, viewer: TestUser;
  let clientId: string;

  beforeEach(async () => {
    owner = await registerUser(app, "owner");
    admin = await addMember(app, owner, "admin");
    member = await addMember(app, owner, "member");
    viewer = await addMember(app, owner, "viewer");
    clientId = (await request(app).post(`/orgs/${owner.orgId}/clients`).set(auth(owner)).send({ name: "Acme" })).body.id;
  });

  it("viewer can read but not create", async () => {
    expect((await request(app).get(`/orgs/${owner.orgId}/clients`).set(auth(viewer))).status).toBe(200);
    const res = await request(app).post(`/orgs/${owner.orgId}/clients`).set(auth(viewer)).send({ name: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("member can create but not delete clients", async () => {
    expect((await request(app).post(`/orgs/${owner.orgId}/clients`).set(auth(member)).send({ name: "x" })).status).toBe(201);
    expect((await request(app).delete(`/orgs/${owner.orgId}/clients/${clientId}`).set(auth(member))).status).toBe(403);
  });

  it("admin can delete clients and read the audit log", async () => {
    expect((await request(app).delete(`/orgs/${owner.orgId}/clients/${clientId}`).set(auth(admin))).status).toBe(204);
    const log = await request(app).get(`/orgs/${owner.orgId}/audit`).set(auth(admin));
    expect(log.status).toBe(200);
    expect(log.body.items[0]).toMatchObject({ action: "client.deleted", actor_id: admin.userId });
  });

  it("admin cannot change roles; owner can", async () => {
    const url = `/orgs/${owner.orgId}/members/${member.userId}`;
    expect((await request(app).patch(url).set(auth(admin)).send({ role: "admin" })).status).toBe(403);
    const res = await request(app).patch(url).set(auth(owner)).send({ role: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("admin");
  });

  it("admin cannot remove the owner or another admin", async () => {
    const other = await addMember(app, owner, "admin", "admin2");
    expect((await request(app).delete(`/orgs/${owner.orgId}/members/${owner.userId}`).set(auth(admin))).status).toBe(403);
    expect((await request(app).delete(`/orgs/${owner.orgId}/members/${other.userId}`).set(auth(admin))).status).toBe(403);
  });

  it("admin can remove a member, who then loses access", async () => {
    expect((await request(app).delete(`/orgs/${owner.orgId}/members/${member.userId}`).set(auth(admin))).status).toBe(204);
    expect((await request(app).get(`/orgs/${owner.orgId}/clients`).set(auth(member))).status).toBe(404);
  });

  it("members can leave; owners cannot leave without transferring ownership", async () => {
    expect((await request(app).delete(`/orgs/${owner.orgId}/members/${viewer.userId}`).set(auth(viewer))).status).toBe(204);
    expect((await request(app).delete(`/orgs/${owner.orgId}/members/${owner.userId}`).set(auth(owner))).status).toBe(400);
  });

  it("nobody can grant a role above their own", async () => {
    const outsider = await registerUser(app, "outsider");
    const res = await request(app)
      .post(`/orgs/${owner.orgId}/members`)
      .set(auth(admin))
      .send({ email: outsider.email, role: "owner" });
    expect(res.status).toBe(400); // "owner" is not even an accepted value here
  });

  it("owner cannot change their own role", async () => {
    const res = await request(app).patch(`/orgs/${owner.orgId}/members/${owner.userId}`).set(auth(owner)).send({ role: "viewer" });
    expect(res.status).toBe(400);
  });
});
