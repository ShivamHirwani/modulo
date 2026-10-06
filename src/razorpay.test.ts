// Razorpay adapter against a STUBBED http layer: proves we send what the docs describe. Does not prove the live API accepts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { RazorpayProvider } from "./razorpay.ts";

const calls: { method: string; url: string; auth: string; body: any }[] = [];
let respond: (url: string, method: string) => { status: number; json: any } = () => ({ status: 200, json: {} });
const stubFetch = (async (url: string, init: any) => {
  calls.push({ method: init.method, url, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
  const r = respond(url, init.method);
  return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.json) };
}) as any;
const store = new Map<string, string>();
const rz = new RazorpayProvider({ keyId: "rzp_test_k", keySecret: "sec", webhookSecret: "whsec", fetch: stubFetch, plans: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); } } });
let n = 0;
respond = (url) => ({ status: 200, json: { id: url.endsWith("/plans") ? `plan_${++n}` : "sub_1" } });

test("creates a plan once per amount, then a subscription with basic auth", async () => {
  const r = await rz.createSubscription({ tenantId: "t1", tenantName: "Acme", email: "a@b.co", currency: "INR", period: "monthly", amountMinor: 395000 });
  assert.equal(r.providerSubId, "sub_1"); assert.equal((r.checkout as any).keyId, "rzp_test_k"); assert.equal((r.checkout as any).subscriptionId, "sub_1");
  assert.equal(calls[0].url, "https://api.razorpay.com/v1/plans");
  assert.deepEqual(calls[0].body, { period: "monthly", interval: 1, item: { name: "Modulo monthly plan", amount: 395000, currency: "INR" } });
  assert.equal(calls[0].auth, "Basic " + Buffer.from("rzp_test_k:sec").toString("base64"));
  assert.equal(calls[1].url, "https://api.razorpay.com/v1/subscriptions");
  assert.deepEqual(calls[1].body, { plan_id: "plan_1", total_count: 120, quantity: 1, customer_notify: 1, notes: { tenant_id: "t1" } });
  const before = calls.length;
  await rz.createSubscription({ tenantId: "t2", tenantName: "B", email: null, currency: "INR", period: "monthly", amountMinor: 395000 });
  assert.equal(calls.slice(before).filter((c) => c.url.endsWith("/plans")).length, 0); // plan reused
  await rz.createSubscription({ tenantId: "t3", tenantName: "C", email: null, currency: "INR", period: "annual", amountMinor: 3000000 });
  assert.equal(calls.at(-2)!.body.period, "yearly");
});

test("plan change is PATCH with cycle_end; rejection maps to PLAN_CHANGE_UNSUPPORTED; cancel body", async () => {
  await rz.changePlan({ providerSubId: "sub_1", currency: "INR", period: "monthly", amountMinor: 111100 });
  const p = calls.at(-1)!; assert.equal(p.method, "PATCH"); assert.equal(p.url, "https://api.razorpay.com/v1/subscriptions/sub_1");
  assert.equal(p.body.schedule_change_at, "cycle_end");
  respond = (url) => (url.includes("/subscriptions/") ? { status: 400, json: { error: { code: "BAD_REQUEST_ERROR", description: "UPI subscriptions cannot be updated" } } } : { status: 200, json: { id: "plan_z" } });
  await assert.rejects(rz.changePlan({ providerSubId: "sub_1", currency: "INR", period: "monthly", amountMinor: 222200 }), (e: any) => e.code === "PLAN_CHANGE_UNSUPPORTED" && /UPI/.test(e.message));
  respond = () => ({ status: 200, json: {} });
  await rz.cancel({ providerSubId: "sub_1", atCycleEnd: true });
  assert.deepEqual(calls.at(-1)!.body, { cancel_at_cycle_end: 1 });
  respond = () => ({ status: 500, json: {} });
  await assert.rejects(rz.cancel({ providerSubId: "sub_1", atCycleEnd: false }), (e: any) => e.code === "PROVIDER_ERROR");
});

test("webhook signature = HMAC-SHA256 of raw body with webhook secret", () => {
  const raw = Buffer.from('{"event":"subscription.charged"}');
  const sig = createHmac("sha256", "whsec").update(raw).digest("hex");
  assert.equal(rz.verifyWebhook(raw, { "x-razorpay-signature": sig }), true);
  assert.equal(rz.verifyWebhook(raw, { "x-razorpay-signature": sig.replace(/.$/, "0") }), false);
  assert.equal(rz.verifyWebhook(Buffer.from('{"event":"subscription.charged" }'), { "x-razorpay-signature": sig }), false); // body changed by one byte
  assert.equal(rz.verifyWebhook(raw, {}), false);
});

test("checkout signature = HMAC(key_secret, payment|subscription)", () => {
  const sig = createHmac("sha256", "sec").update("pay_9|sub_1").digest("hex");
  assert.equal(rz.verifyCheckout({ paymentId: "pay_9", subscriptionId: "sub_1", signature: sig }), true);
  assert.equal(rz.verifyCheckout({ paymentId: "pay_9", subscriptionId: "sub_2", signature: sig }), false);
});

test("parses charged / halted payloads; ignores events we do not act on", () => {
  const charged = Buffer.from(JSON.stringify({ event: "subscription.charged", created_at: 1760000000, payload: { subscription: { entity: { id: "sub_1", current_start: 1760000000, current_end: 1762592000 } }, payment: { entity: { id: "pay_1", amount: 395000, currency: "INR" } } } }));
  const e = rz.parseWebhook(charged, { "x-razorpay-event-id": "evt_abc" })!;
  assert.equal(e.id, "evt_abc"); assert.equal(e.type, "charged"); assert.equal(e.providerSubId, "sub_1"); assert.equal(e.paymentId, "pay_1"); assert.equal(e.amountMinor, 395000);
  assert.equal(e.periodStart!.getTime(), 1760000000_000); assert.equal(e.periodEnd!.getTime(), 1762592000_000);
  const noHdr = rz.parseWebhook(charged, {})!; assert.equal(noHdr.id.length, 64); // falls back to a hash of the body
  const halted = rz.parseWebhook(Buffer.from(JSON.stringify({ event: "subscription.halted", created_at: 1, payload: { subscription: { entity: { id: "sub_1" } } } })), {})!;
  assert.equal(halted.type, "halted");
  assert.equal(rz.parseWebhook(Buffer.from(JSON.stringify({ event: "payment.failed", payload: {} })), {}), null);
});

test("only INR until other currencies are confirmed enabled", () => {
  assert.equal(rz.supports("INR"), true); assert.equal(rz.supports("USD"), false);
});
