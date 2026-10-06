// Integration tests: real Postgres (db/run_tests.sh builds modulo_test). Needs DATABASE_URL (modulo_app) and
// ADMIN_DATABASE_URL (superuser, only to simulate suspended/expired tenants).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildApp } from "./app.ts";

const URL = process.env.DATABASE_URL!;
const ADMIN = process.env.ADMIN_DATABASE_URL!;
if (!URL || !ADMIN) throw new Error("set DATABASE_URL and ADMIN_DATABASE_URL");

const app = await buildApp({ databaseUrl: URL, rateLimitMax: 1000 });
const admin = new pg.Pool({ connectionString: ADMIN });
after(async () => { await app.close(); await admin.end(); });

const call = async (method: any, url: string, body?: unknown, token?: string) => {
  const r = await app.inject({ method, url, payload: body as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.json() as any };
};
const uniq = () => Math.random().toString(36).slice(2, 10);
const signup = async (tag: string) => {
  const email = `${tag}-${uniq()}@test.dev`;
  const r = await call("POST", "/auth/signup", { companyName: `Co ${tag}`, name: tag, email, password: "correct-horse-battery" });
  assert.equal(r.status, 201);
  return { email, token: r.body.token as string, tenantId: r.body.tenant.id as string };
};
const ALL4 = ["quote", "bill", "assets", "dept"];

const A = await signup("alpha");
const B = await signup("bravo");

test("signup validation + duplicate email", async () => {
  assert.equal((await call("POST", "/auth/signup", { companyName: "X Co", name: "x", email: "x@test.dev", password: "short" })).status, 400);
  assert.equal((await call("POST", "/auth/signup", { companyName: "Dup", name: "d", email: A.email, password: "correct-horse-battery" })).status, 409);
});

test("login: wrong password and unknown email look identical; right password works", async () => {
  const bad = await call("POST", "/auth/login", { email: A.email, password: "nope-nope-nope" });
  const none = await call("POST", "/auth/login", { email: "ghost@test.dev", password: "nope-nope-nope" });
  assert.equal(bad.status, 401); assert.deepEqual(bad.body, none.body);
  const ok = await call("POST", "/auth/login", { email: A.email, password: "correct-horse-battery" });
  assert.equal(ok.status, 200); assert.ok(ok.body.token);
});

test("auth required; /me works", async () => {
  assert.equal((await call("GET", "/me")).status, 401);
  assert.equal((await call("GET", "/me", undefined, "mod_garbage")).status, 401);
  const me = await call("GET", "/me", undefined, A.token);
  assert.equal(me.body.role, "owner"); assert.equal(me.body.tenant.id, A.tenantId);
});

test("public quote uses pricing engine ($114.15 / $91.32); rejects bad input and client-supplied totals", async () => {
  const q = await call("POST", "/pricing/quote", { moduleIds: ALL4, seats: 10, billing: "monthly", currency: "USD" });
  assert.equal(q.body.monthlyTotal, 11415);
  assert.equal((await call("POST", "/pricing/quote", { moduleIds: ALL4, seats: 10, billing: "annual", currency: "USD" })).body.monthlyTotal, 9132);
  assert.equal((await call("POST", "/pricing/quote", { moduleIds: ALL4, seats: 301, billing: "monthly", currency: "USD" })).body.error, "ENTERPRISE_REQUIRED");
  assert.equal((await call("POST", "/pricing/quote", { moduleIds: ["hr"], seats: 1, billing: "monthly", currency: "USD" })).status, 400); // not launched / unknown
  assert.equal((await call("POST", "/pricing/quote", { moduleIds: [], seats: 1, billing: "monthly", currency: "USD", total: 1 })).status, 400);
});

test("module routes blocked until subscribed", async () => {
  const r = await call("GET", "/departments", undefined, A.token);
  assert.equal(r.status, 403); assert.equal(r.body.error, "MODULE_NOT_ENABLED");
});

test("subscribe: server sets price, entitlements follow; client price field rejected", async () => {
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 2, billing: "monthly", total: 1 }, A.token)).status, 400);
  const r = await call("PUT", "/subscription", { moduleIds: ["dept", "assets"], seats: 2, billing: "monthly" }, A.token);
  assert.equal(r.status, 200); assert.equal(r.body.quote.monthlyTotal, 1200 + 1500 + 2 * 600);
  assert.equal((await call("GET", "/departments", undefined, A.token)).status, 200);
  const d = await call("POST", "/departments", { name: "Finance" }, A.token);
  assert.equal(d.status, 201);
  assert.equal((await call("GET", "/departments", undefined, A.token)).body.items.length, 1);
  assert.equal((await call("GET", "/assets", undefined, A.token)).status, 200);
});

let memberToken = "";
test("team: seat limit, role limits", async () => {
  const mEmail = `m-${uniq()}@test.dev`;
  assert.equal((await call("POST", "/team/members", { name: "Mia", email: mEmail, password: "member-pass-1234", role: "member" }, A.token)).status, 201);
  assert.equal((await call("POST", "/team/members", { name: "Zed", email: `z-${uniq()}@test.dev`, password: "member-pass-1234", role: "member" }, A.token)).body.error, "SEAT_LIMIT");
  memberToken = (await call("POST", "/auth/login", { email: mEmail, password: "member-pass-1234" })).body.token;
  assert.equal((await call("GET", "/departments", undefined, memberToken)).status, 200);
  assert.equal((await call("POST", "/departments", { name: "Nope" }, memberToken)).body.error, "FORBIDDEN_ROLE");
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 2, billing: "monthly" }, memberToken)).status, 403);
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 1, billing: "monthly" }, A.token)).body.error, "SEATS_BELOW_MEMBERS");
});

test("removing a module revokes access immediately", async () => {
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 2, billing: "monthly" }, A.token)).status, 200);
  assert.equal((await call("GET", "/assets", undefined, A.token)).body.error, "MODULE_NOT_ENABLED");
  assert.equal((await call("GET", "/departments", undefined, A.token)).status, 200);
});

test("tenants are isolated end to end", async () => {
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept", "assets"], seats: 1, billing: "annual" }, B.token)).status, 200);
  assert.equal((await call("GET", "/departments", undefined, B.token)).body.items.length, 0); // A has one; B sees none
  const aDept = (await call("GET", "/departments", undefined, A.token)).body.items[0].id;
  const x = await call("POST", "/assets", { tag: "L1", name: "Laptop", departmentId: aDept }, B.token);
  assert.equal(x.status, 422); assert.equal(x.body.error, "INVALID_REFERENCE"); // cannot link to other tenant's department
  assert.equal((await call("POST", "/assets", { tag: "L1", name: "Laptop" }, B.token)).status, 201);
  assert.equal((await call("POST", "/assets", { tag: "L1", name: "Dup" }, B.token)).status, 409);
});

test("suspended and expired-trial accounts are blocked from modules", async () => {
  await admin.query("UPDATE tenants SET status='suspended' WHERE id=$1", [A.tenantId]);
  assert.equal((await call("GET", "/departments", undefined, A.token)).body.error, "ACCOUNT_INACTIVE");
  await admin.query("UPDATE tenants SET status='trial', trial_ends_at = now() - interval '1 day' WHERE id=$1", [A.tenantId]);
  assert.equal((await call("GET", "/departments", undefined, A.token)).body.error, "TRIAL_ENDED");
  assert.equal((await call("GET", "/me", undefined, A.token)).status, 200); // can still log in and fix billing
});

test("enterprise inquiry stored; logout kills token", async () => {
  assert.equal((await call("POST", "/enterprise/inquiry", { name: "Big Corp", email: "cto@big.com", teamSize: "1,000+" })).status, 201);
  const s = await signup("charlie");
  assert.equal((await call("POST", "/auth/logout", undefined, s.token)).status, 200);
  assert.equal((await call("GET", "/me", undefined, s.token)).status, 401);
});

test("auth endpoints are rate limited", async () => {
  const limited = await buildApp({ databaseUrl: URL, rateLimitMax: 3 });
  let last = 0;
  for (let i = 0; i < 5; i++) last = (await limited.inject({ method: "POST", url: "/auth/login", payload: { email: "a@b.co", password: "x" } })).statusCode;
  await limited.close();
  assert.equal(last, 429);
});
