// Subscription lifecycle with the FAKE provider, on real Postgres.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildApp } from "./app.ts";
import { FakeProvider } from "./provider.ts";

const URL = process.env.DATABASE_URL!, ADMIN = process.env.ADMIN_DATABASE_URL!;
if (!URL || !ADMIN) throw new Error("set DATABASE_URL and ADMIN_DATABASE_URL");
const fake = new FakeProvider();
const app = await buildApp({ databaseUrl: URL, rateLimitMax: 1000, billing: () => fake as any, billingDevSimulate: true });
const admin = new pg.Pool({ connectionString: ADMIN });
after(async () => { await app.close(); await admin.end(); });

const call = async (method: any, url: string, body?: unknown, token?: string) => {
  const r = await app.inject({ method, url, payload: body as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.json() as any };
};
const uniq = () => Math.random().toString(36).slice(2, 10);
const signup = async (tag: string) => {
  const r = await call("POST", "/auth/signup", { companyName: `Co ${tag}`, name: tag, email: `${tag}-${uniq()}@test.dev`, password: "correct-horse-battery", currency: "INR" });
  return { token: r.body.token as string, tenantId: r.body.tenant.id as string };
};
const hook = async (subId: string, type: any, o: any = {}) => {
  const e = fake.makeEvent(subId, type, o);
  const r = await app.inject({ method: "POST", url: "/webhooks/fake", payload: e.body, headers: e.headers });
  return { status: r.statusCode, body: r.json() as any, id: JSON.parse(e.body).id as string };
};
const status = async (t: { token: string }) => (await call("GET", "/subscription", undefined, t.token)).body;
const DAY = 86_400_000;
const R = uniq(); // unique per run so reruns on the same DB never collide

const A = await signup("bill-a");
let subId = "";

test("trial: modules work; checkout needs a plan first, owner only, amount decided by server", async () => {
  assert.equal((await call("POST", "/billing/checkout", {}, A.token)).body.error, "NO_SUBSCRIPTION");
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept", "assets"], seats: 3, billing: "monthly" }, A.token)).status, 200);
  const st = await status(A);
  assert.equal(st.status, "trial"); assert.equal(st.needsPayment, true); assert.ok(st.trialDaysLeft >= 13);
  assert.equal((await call("GET", "/departments", undefined, A.token)).status, 200);
  const email = `adm-${uniq()}@test.dev`;
  await call("POST", "/team/members", { name: "Adm", email, password: "member-pass-1234", role: "admin" }, A.token);
  const memberTok = (await call("POST", "/auth/login", { email, password: "member-pass-1234" })).body.token;
  assert.equal((await call("POST", "/billing/cancel", {}, memberTok)).body.error, "FORBIDDEN_ROLE");
  const r = await call("POST", "/billing/checkout", { amountMinor: 1 }, A.token); // extra field ignored: body not even read
  assert.equal(r.status, 200);
  assert.equal(r.body.amountMinor, r.body.quote.periodTotal); // amount comes from the pricing engine, not the request
  assert.equal(r.body.quote.periodTotal, 105600 + 132000 + 3 * 52800);
  subId = r.body.checkout.subscriptionId;
  assert.equal(fake.calls.at(-1)!.args.amountMinor, r.body.quote.periodTotal);
});

test("webhook: bad or missing signature rejected, nothing stored", async () => {
  const e = fake.makeEvent(subId, "charged", { paymentId: `p0_${R}`, amountMinor: 1 });
  const bad = await app.inject({ method: "POST", url: "/webhooks/fake", payload: e.body, headers: { ...e.headers, "x-fake-signature": "0".repeat(64) } });
  assert.equal(bad.statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/fake", payload: e.body, headers: { "content-type": "application/json" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/razorpay", payload: e.body, headers: e.headers })).statusCode, 404);
  assert.equal((await admin.query("SELECT 1 FROM webhook_events WHERE payload->>'paymentId' = $1", [`p0_${R}`])).rowCount, 0);
});

test("activated + charged: tenant becomes active, period set from provider, invoice recorded once", async () => {
  const t0 = Date.now();
  assert.equal((await hook(subId, "activated", { createdAt: t0, periodStart: t0, periodEnd: t0 + 30 * DAY })).body.result, "applied");
  const ch = await hook(subId, "charged", { createdAt: t0 + 1, paymentId: `pay_1_${R}`, amountMinor: 395000, currency: "INR", periodStart: t0, periodEnd: t0 + 30 * DAY });
  assert.equal(ch.status, 200);
  const st = await status(A);
  assert.equal(st.status, "active"); assert.equal(st.needsPayment, false); assert.equal(st.subscription.provider_status, "active");
  assert.equal(new Date(st.subscription.period_end).getTime(), t0 + 30 * DAY);
  const inv = await admin.query("SELECT total_minor, status FROM platform_invoices WHERE provider_invoice_id = $1", [`pay_1_${R}`]);
  assert.equal(inv.rowCount, 1); assert.equal(Number(inv.rows[0].total_minor), 395000); assert.equal(inv.rows[0].status, "paid");
  assert.equal((await call("POST", "/billing/checkout", {}, A.token)).body.error, "ALREADY_SUBSCRIBED");
});

test("same event twice is processed once; unknown subscription is acknowledged and ignored", async () => {
  const e = fake.makeEvent(subId, "charged", { id: `evt_dup_${R}`, paymentId: `pay_dup_${R}`, amountMinor: 5, createdAt: Date.now() + 10 });
  const send = () => app.inject({ method: "POST", url: "/webhooks/fake", payload: e.body, headers: e.headers });
  assert.equal((await send()).json().result, "applied");
  assert.equal((await send()).json().duplicate, true);
  assert.equal((await admin.query("SELECT 1 FROM platform_invoices WHERE provider_invoice_id = $1", [`pay_dup_${R}`])).rowCount, 1);
  const u = await hook("fake_sub_nope", "charged", { paymentId: `pay_x_${R}` });
  assert.equal(u.status, 200); assert.equal(u.body.unknown, true);
});

test("out-of-order: an older 'pending' arriving late does not downgrade an active account", async () => {
  const r = await hook(subId, "pending", { createdAt: Date.now() - 60 * DAY });
  assert.equal(r.body.result, "stale");
  assert.equal((await status(A)).status, "active");
});

test("failed payment: past_due keeps access; halted blocks; later charge restores", async () => {
  const now = Date.now();
  await hook(subId, "pending", { createdAt: now + 1000 });
  assert.equal((await status(A)).status, "past_due");
  assert.equal((await call("GET", "/departments", undefined, A.token)).status, 200); // grace
  await hook(subId, "halted", { createdAt: now + 2000 });
  assert.equal((await status(A)).status, "suspended");
  assert.equal((await call("GET", "/departments", undefined, A.token)).body.error, "ACCOUNT_INACTIVE");
  assert.equal((await call("GET", "/me", undefined, A.token)).status, 200); // can still log in and pay
  await hook(subId, "charged", { createdAt: now + 3000, paymentId: `pay_back_${R}`, amountMinor: 395000, periodStart: now, periodEnd: now + 30 * DAY });
  assert.equal((await status(A)).status, "active");
  assert.equal((await call("GET", "/departments", undefined, A.token)).status, 200);
});

test("paid plan change is scheduled (not applied) until the next renewal charge", async () => {
  const before = await status(A);
  const r = await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 2, billing: "monthly" }, A.token);
  assert.equal(r.status, 200); assert.equal(r.body.scheduled, true);
  assert.equal(fake.calls.at(-1)!.op, "change"); assert.equal(fake.calls.at(-1)!.args.amountMinor, r.body.quote.periodTotal);
  const mid = await status(A);
  assert.deepEqual(mid.modules, before.modules); assert.equal(mid.subscription.seats, 3); assert.equal(mid.subscription.pending.seats, 2);
  assert.equal((await call("GET", "/assets", undefined, A.token)).status, 200); // still entitled this cycle
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 2, billing: "annual" }, A.token)).body.error, "BILLING_PERIOD_LOCKED");
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 0, billing: "monthly" }, A.token)).status, 400);
  // a charge inside the same period (retry/duplicate) must not apply it
  const st = await status(A); const end = new Date(st.subscription.period_end).getTime(), start = new Date(st.subscription.period_start).getTime();
  await hook(subId, "charged", { createdAt: Date.now() + 5000, paymentId: `pay_same_${R}`, amountMinor: 1, periodStart: start, periodEnd: end });
  assert.equal((await status(A)).modules.length, 2);
  // renewal: new period starts at old end -> change goes live
  await hook(subId, "charged", { createdAt: Date.now() + 6000, paymentId: `pay_renew_${R}`, amountMinor: 3, periodStart: end, periodEnd: end + 30 * DAY });
  const after = await status(A);
  assert.deepEqual(after.modules, ["dept"]); assert.equal(after.subscription.seats, 2); assert.equal(after.subscription.pending, null);
  assert.equal((await call("GET", "/assets", undefined, A.token)).body.error, "MODULE_NOT_ENABLED");
});

test("provider refusal (e.g. UPI autopay) leaves everything unchanged", async () => {
  fake.failChange = true;
  const r = await call("PUT", "/subscription", { moduleIds: ["dept", "assets"], seats: 5, billing: "monthly" }, A.token);
  assert.equal(r.status, 409); assert.equal(r.body.error, "PLAN_CHANGE_UNSUPPORTED");
  fake.failChange = false;
  assert.equal((await status(A)).subscription.pending, null);
});

test("a scheduled seat cut lowers the hiring cap now; a scheduled increase does not raise it", async () => {
  const C = await signup("bill-seats");
  await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 5, billing: "monthly" }, C.token);
  await call("POST", "/billing/checkout", {}, C.token);
  await call("POST", "/dev/billing/simulate", { type: "charged" }, C.token);
  const add = (n: string) => call("POST", "/team/members", { name: n, email: `${n}-${uniq()}@test.dev`, password: "member-pass-1234", role: "member" }, C.token);
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 2, billing: "monthly" }, C.token)).body.scheduled, true);
  assert.equal((await add("m1")).status, 201); // 2 of cap 2
  assert.equal((await add("m2")).body.error, "SEAT_LIMIT"); // paid for 5 now, but the cut already caps hiring
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 5, billing: "monthly" }, C.token)).body.scheduled, false); // back to current: change cleared
  assert.equal((await add("m2")).status, 201);
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 8, billing: "monthly" }, C.token)).body.scheduled, true);
  assert.equal((await add("m3")).status, 201); assert.equal((await add("m4")).status, 201); // 5 of 5
  assert.equal((await add("m5")).body.error, "SEAT_LIMIT"); // increase to 8 only starts next cycle
});

test("cancel at cycle end: access stays until provider confirms, then blocked", async () => {
  const r = await call("POST", "/billing/cancel", {}, A.token);
  assert.equal(r.status, 200); assert.deepEqual(fake.calls.at(-1)!.args, { providerSubId: subId, atCycleEnd: true });
  assert.equal((await status(A)).subscription.cancel_at_period_end, true);
  assert.equal((await call("GET", "/departments", undefined, A.token)).status, 200);
  await hook(subId, "cancelled", { createdAt: Date.now() + 10_000 });
  assert.equal((await status(A)).status, "cancelled");
  assert.equal((await call("GET", "/departments", undefined, A.token)).body.error, "ACCOUNT_INACTIVE");
  assert.equal((await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 2, billing: "monthly" }, A.token)).body.error, "ACCOUNT_INACTIVE");
});

test("trial expiry blocks until paid; changing selection voids an unpaid checkout", async () => {
  const T = await signup("bill-trial");
  await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 1, billing: "monthly" }, T.token);
  await admin.query("UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1", [T.tenantId]);
  assert.equal((await call("GET", "/departments", undefined, T.token)).body.error, "TRIAL_ENDED");
  const c1 = await call("POST", "/billing/checkout", {}, T.token);
  await call("PUT", "/subscription", { moduleIds: ["dept", "assets"], seats: 1, billing: "monthly" }, T.token); // selection changed after checkout
  assert.equal((await admin.query("SELECT provider_sub_id FROM subscriptions WHERE tenant_id = $1", [T.tenantId])).rows[0].provider_sub_id, null);
  const late = await hook(c1.body.checkout.subscriptionId, "charged", { paymentId: `pay_late_${R}`, amountMinor: 1 });
  assert.equal(late.body.unknown, true); // stale checkout can no longer activate anything
  const c2 = await call("POST", "/billing/checkout", {}, T.token);
  await call("POST", "/dev/billing/simulate", { type: "charged" }, T.token);
  assert.equal((await status(T)).status, "active");
  assert.equal((await call("GET", "/departments", undefined, T.token)).status, 200);
  assert.ok(c2.body.checkout.subscriptionId);
});

test("another tenant cannot touch ours; events only affect the subscription they name", async () => {
  const B = await signup("bill-b");
  await call("PUT", "/subscription", { moduleIds: ["dept"], seats: 1, billing: "monthly" }, B.token);
  assert.equal((await call("POST", "/billing/cancel", {}, B.token)).body.error, "NO_ACTIVE_SUBSCRIPTION");
  assert.equal((await call("POST", "/dev/billing/simulate", { type: "charged" }, B.token)).body.error, "NO_CHECKOUT");
  assert.equal((await status(B)).status, "trial"); // A's events never touched B
});

test("dev simulator is absent unless enabled", async () => {
  const plain = await buildApp({ databaseUrl: URL, billing: () => fake as any });
  const r = await plain.inject({ method: "POST", url: "/dev/billing/simulate", payload: {} });
  await plain.close();
  assert.equal(r.statusCode, 404);
});
