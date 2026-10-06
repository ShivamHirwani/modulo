// Quote -> invoice -> payment, end to end on real Postgres, plus DB-level lock checks.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildApp } from "./app.ts";

const URL = process.env.DATABASE_URL!, ADMIN = process.env.ADMIN_DATABASE_URL!;
if (!URL || !ADMIN) throw new Error("set DATABASE_URL and ADMIN_DATABASE_URL");
const app = await buildApp({ databaseUrl: URL, rateLimitMax: 1000 });
const admin = new pg.Pool({ connectionString: ADMIN });
const appPool = new pg.Pool({ connectionString: URL }); // raw app-role access to test DB triggers
after(async () => { await app.close(); await admin.end(); await appPool.end(); });

const call = async (method: any, url: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method, url, payload: body as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: r.statusCode, body: r.json() as any };
};
const uniq = () => Math.random().toString(36).slice(2, 10);
const signup = async (tag: string) => {
  const email = `${tag}-${uniq()}@test.dev`;
  const r = await call("POST", "/auth/signup", { companyName: `Co ${tag}`, name: tag, email, password: "correct-horse-battery" });
  return { email, token: r.body.token as string, tenantId: r.body.tenant.id as string };
};
// raw SQL as app role inside a tenant: returns error code or "ok"
const raw = async (tenantId: string, sql: string, params: any[] = []) => {
  const c = await appPool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await c.query(sql, params); await c.query("ROLLBACK"); return "ok";
  } catch (e: any) { await c.query("ROLLBACK").catch(() => {}); return e.code as string; } finally { c.release(); }
};

const A = await signup("money-a");
const B = await signup("money-b");
const sub = (t: string, mods: string[], seats = 5) => call("PUT", "/subscription", { moduleIds: mods, seats, billing: "monthly" }, t);
assert.equal((await sub(A.token, ["quote", "bill"])).status, 200);
const ITEMS = [
  { description: "Website build", qty: 1, unitMinor: 100000, taxBps: 1800 },
  { description: "Hosting (months)", qty: 12, unitMinor: 2500, taxBps: 0 },
];
let company = "", quoteId = "", invoiceId = "";

test("create company; quote totals computed by server", async () => {
  company = (await call("POST", "/companies", { name: "Acme Ltd" }, A.token)).body.id;
  const q = await call("POST", "/quotes", { companyId: company, items: ITEMS, total: 1 }, A.token);
  assert.equal(q.status, 400); // client may not send totals
  const ok = await call("POST", "/quotes", { companyId: company, items: ITEMS }, A.token);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.number, "QUO-0001"); assert.equal(ok.body.status, "draft");
  assert.equal(ok.body.subtotalMinor, 130000); assert.equal(ok.body.taxMinor, 18000); assert.equal(ok.body.totalMinor, 148000);
  quoteId = ok.body.id;
});

test("draft is editable; send needs lines; sent is locked (API and DB)", async () => {
  const empty = (await call("POST", "/quotes", { companyId: company }, A.token)).body.id;
  assert.equal((await call("POST", `/quotes/${empty}/send`, undefined, A.token)).body.error, "EMPTY_DOCUMENT");
  assert.equal((await call("DELETE", `/quotes/${empty}`, undefined, A.token)).status, 200);
  const up = await call("PUT", `/quotes/${quoteId}`, { items: [{ description: "x", qty: 2, unitMinor: 1000 }] }, A.token);
  assert.equal(up.body.totalMinor, 2000);
  await call("PUT", `/quotes/${quoteId}`, { items: ITEMS }, A.token);
  const s = await call("POST", `/quotes/${quoteId}/send`, undefined, A.token);
  assert.equal(s.body.status, "sent"); assert.ok(s.body.validUntil);
  assert.equal((await call("PUT", `/quotes/${quoteId}`, { items: [] }, A.token)).body.error, "NOT_DRAFT");
  assert.equal(await raw(A.tenantId, "UPDATE quote_items SET unit_minor = 1 WHERE quote_id = $1", [quoteId]), "MD001"); // DB refuses even if API is bypassed
  assert.equal(await raw(A.tenantId, "UPDATE quotes SET total_minor = 1, subtotal_minor = 1, tax_minor = 0 WHERE id = $1", [quoteId]), "MD001");
  assert.equal(await raw(A.tenantId, "UPDATE quotes SET status = 'draft' WHERE id = $1", [quoteId]), "MD002");
});

test("reject then revise makes version 2, old superseded", async () => {
  const q = (await call("POST", "/quotes", { companyId: company, items: ITEMS }, A.token)).body;
  await call("POST", `/quotes/${q.id}/send`, undefined, A.token);
  assert.equal((await call("POST", `/quotes/${q.id}/reject`, undefined, A.token)).body.status, "rejected");
  const v2 = await call("POST", `/quotes/${q.id}/revise`, undefined, A.token);
  assert.equal(v2.status, 201); assert.equal(v2.body.number, q.number); assert.equal(v2.body.version, 2);
  assert.equal(v2.body.status, "draft"); assert.equal(v2.body.items.length, 2);
  assert.equal((await call("GET", `/quotes/${q.id}`, undefined, A.token)).body.status, "superseded");
});

test("expired quote cannot be accepted", async () => {
  const q = (await call("POST", "/quotes", { companyId: company, items: ITEMS, validUntil: "2020-01-01" }, A.token)).body;
  await call("POST", `/quotes/${q.id}/send`, undefined, A.token);
  assert.equal((await call("GET", `/quotes/${q.id}`, undefined, A.token)).body.status, "expired");
  assert.equal((await call("POST", `/quotes/${q.id}/accept`, undefined, A.token)).body.error, "QUOTE_EXPIRED");
});

test("cannot convert before accept; accept; convert needs bill module", async () => {
  assert.equal((await call("POST", `/quotes/${quoteId}/convert`, {}, A.token)).body.error, "INVALID_STATE");
  assert.equal((await call("POST", `/quotes/${quoteId}/accept`, undefined, A.token)).body.status, "accepted");
  const only = await signup("only-quote");
  await sub(only.token, ["quote"]);
  const co = (await call("POST", "/companies", { name: "Z" }, only.token)).body.id;
  const q = (await call("POST", "/quotes", { companyId: co, items: ITEMS }, only.token)).body.id;
  await call("POST", `/quotes/${q}/send`, undefined, only.token); await call("POST", `/quotes/${q}/accept`, undefined, only.token);
  const r = await call("POST", `/quotes/${q}/convert`, {}, only.token);
  assert.equal(r.status, 403); assert.equal(r.body.error, "MODULE_NOT_ENABLED");
  assert.equal((await call("GET", "/invoices", undefined, only.token)).status, 403);
});

test("convert: invoice draft copies lines + totals, no number yet; second convert blocked", async () => {
  const r = await call("POST", `/quotes/${quoteId}/convert`, { dueDays: 30 }, A.token);
  assert.equal(r.status, 201);
  assert.equal(r.body.status, "draft"); assert.equal(r.body.number, null); assert.equal(r.body.quoteId, quoteId);
  assert.equal(r.body.totalMinor, 148000); assert.equal(r.body.items.length, 2); assert.equal(r.body.balanceMinor, 148000);
  invoiceId = r.body.id;
  assert.equal((await call("GET", `/quotes/${quoteId}`, undefined, A.token)).body.status, "converted");
  assert.equal((await call("POST", `/quotes/${quoteId}/convert`, {}, A.token)).body.error, "ALREADY_INVOICED");
});

test("send invoice: gets INV-0001, locked in API and DB", async () => {
  const s = await call("POST", `/invoices/${invoiceId}/send`, undefined, A.token);
  assert.equal(s.body.status, "sent"); assert.equal(s.body.number, "INV-0001");
  assert.equal((await call("PUT", `/invoices/${invoiceId}`, { items: [] }, A.token)).body.error, "NOT_DRAFT");
  assert.equal((await call("DELETE", `/invoices/${invoiceId}`, undefined, A.token)).body.error, "NOT_DRAFT");
  assert.equal(await raw(A.tenantId, "UPDATE customer_invoices SET total_minor = 1, subtotal_minor = 1, tax_minor = 0 WHERE id = $1", [invoiceId]), "MD001");
  assert.equal(await raw(A.tenantId, "DELETE FROM customer_invoice_items WHERE invoice_id = $1", [invoiceId]), "MD001");
  assert.equal(await raw(A.tenantId, "DELETE FROM customer_invoices WHERE id = $1", [invoiceId]), "MD001");
});

test("payments: partial, overpay blocked, idempotent retry, paid, no more", async () => {
  const pay = (amt: number, key?: string) => call("POST", `/invoices/${invoiceId}/payments`, { amountMinor: amt, method: "bank" }, A.token, key ? { "idempotency-key": key } : {});
  const p1 = await pay(50000, "k1");
  assert.equal(p1.status, 201); assert.equal(p1.body.invoice.status, "partial"); assert.equal(p1.body.invoice.balanceMinor, 98000);
  const again = await pay(50000, "k1");
  assert.equal(again.status, 200); assert.equal(again.body.replay, true); assert.equal(again.body.paymentId, p1.body.paymentId);
  assert.equal(again.body.invoice.paidMinor, 50000); // not double counted
  assert.equal((await pay(60000, "k1")).body.error, "IDEMPOTENCY_KEY_REUSED");
  const over = await pay(98001); assert.equal(over.status, 422); assert.equal(over.body.error, "OVERPAYMENT");
  assert.equal((await call("POST", `/invoices/${invoiceId}/void`, undefined, A.token)).body.error, "INVALID_STATE"); // has payments
  const p2 = await pay(98000); assert.equal(p2.body.invoice.status, "paid"); assert.equal(p2.body.invoice.balanceMinor, 0);
  assert.equal((await pay(1)).body.error, "INVALID_STATE");
  assert.equal(await raw(A.tenantId, "UPDATE payments SET amount_minor = 1", []), "MD003");
  assert.equal(await raw(A.tenantId, "DELETE FROM payments", []), "MD003");
  const s = await call("GET", "/billing/summary", undefined, A.token);
  assert.equal(s.body.byCurrency.USD.paidThisMonthMinor, 148000);
});

test("gapless numbers: deleted drafts burn nothing; parallel sends get distinct consecutive numbers", async () => {
  const mk = async () => (await call("POST", "/invoices", { companyId: company, items: [{ description: "x", qty: 1, unitMinor: 1000 }] }, A.token)).body.id as string;
  const burn = await mk(); await call("DELETE", `/invoices/${burn}`, undefined, A.token);
  const [i1, i2, i3] = await Promise.all([mk(), mk(), mk()]);
  const rs = await Promise.all([i1, i2, i3].map((i) => call("POST", `/invoices/${i}/send`, undefined, A.token)));
  const nums = rs.map((r) => r.body.number).sort();
  assert.deepEqual(nums, ["INV-0002", "INV-0003", "INV-0004"]);
});

test("void frees the quote to be converted again", async () => {
  const q = (await call("POST", "/quotes", { companyId: company, items: ITEMS }, A.token)).body.id;
  await call("POST", `/quotes/${q}/send`, undefined, A.token); await call("POST", `/quotes/${q}/accept`, undefined, A.token);
  const inv = (await call("POST", `/quotes/${q}/convert`, {}, A.token)).body.id;
  await call("POST", `/invoices/${inv}/send`, undefined, A.token);
  assert.equal((await call("POST", `/invoices/${inv}/void`, undefined, A.token)).body.status, "void");
  assert.equal((await call("POST", `/quotes/${q}/convert`, {}, A.token)).status, 201);
});

test("overdue shows in list and summary; can still be paid", async () => {
  const id = (await call("POST", "/invoices", { companyId: company, issueDate: "2020-01-01", dueDate: "2020-01-15", items: [{ description: "old", qty: 1, unitMinor: 7000 }] }, A.token)).body.id;
  const s = await call("POST", `/invoices/${id}/send`, undefined, A.token);
  assert.equal(s.body.status, "overdue");
  assert.ok((await call("GET", "/invoices?status=overdue", undefined, A.token)).body.items.some((i: any) => i.id === id));
  assert.ok((await call("GET", "/billing/summary", undefined, A.token)).body.byCurrency.USD.overdueMinor >= 7000);
  assert.equal((await call("POST", `/invoices/${id}/payments`, { amountMinor: 7000 }, A.token)).body.invoice.status, "paid");
  assert.equal((await call("POST", "/invoices", { companyId: company, issueDate: "2026-05-10", dueDate: "2026-05-01" }, A.token)).status, 400);
});

test("viewer is read only; member cannot record payments", async () => {
  await call("POST", "/team/members", { name: "V", email: `v-${uniq()}@test.dev`, password: "viewer-pass-1234", role: "viewer" }, A.token);
  const vEmail = (await admin.query("SELECT email FROM users WHERE name='V' ORDER BY created_at DESC LIMIT 1")).rows[0].email;
  const v = (await call("POST", "/auth/login", { email: vEmail, password: "viewer-pass-1234" })).body.token;
  assert.equal((await call("GET", "/quotes", undefined, v)).status, 200);
  assert.equal((await call("POST", "/quotes", { companyId: company }, v)).body.error, "FORBIDDEN_ROLE");
  await call("POST", "/team/members", { name: "M", email: `m-${uniq()}@test.dev`, password: "member-pass-1234", role: "member" }, A.token);
  const mEmail = (await admin.query("SELECT email FROM users WHERE name='M' ORDER BY created_at DESC LIMIT 1")).rows[0].email;
  const m = (await call("POST", "/auth/login", { email: mEmail, password: "member-pass-1234" })).body.token;
  assert.equal((await call("POST", `/invoices/${invoiceId}/payments`, { amountMinor: 1 }, m)).body.error, "FORBIDDEN_ROLE");
});

test("other tenant cannot see or touch these documents", async () => {
  await sub(B.token, ["quote", "bill"]);
  assert.equal((await call("GET", `/quotes/${quoteId}`, undefined, B.token)).status, 404);
  assert.equal((await call("GET", `/invoices/${invoiceId}`, undefined, B.token)).status, 404);
  assert.equal((await call("POST", `/invoices/${invoiceId}/payments`, { amountMinor: 1 }, B.token)).status, 404);
  assert.equal((await call("POST", "/quotes", { companyId: company, items: ITEMS }, B.token)).body.error, "INVALID_REFERENCE");
  assert.equal((await call("GET", "/quotes", undefined, B.token)).body.items.length, 0);
  const b1 = await call("POST", "/companies", { name: "B Co" }, B.token);
  const bq = await call("POST", "/quotes", { companyId: b1.body.id, items: ITEMS }, B.token);
  assert.equal(bq.body.number, "QUO-0001"); // each tenant has its own numbering
});
