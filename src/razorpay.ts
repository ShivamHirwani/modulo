// Razorpay adapter. Written from Razorpay's public docs (plans, subscriptions, update, cancel, webhooks, checkout signature).
// NOT yet run against the live API: verify every call in Razorpay TEST mode before taking real money.
// Points to verify first: (1) cancel body param name, (2) X-Razorpay-Event-Id header, (3) whether USD/EUR subscriptions are enabled
// on your account (supports() is INR-only until you confirm), (4) how plan changes behave for UPI-authorised subscriptions.
import { createHash } from "node:crypto";
import { ProviderError, hmacHex, safeEqualHex } from "./provider.ts";
import type { BillingProvider, Period, ProviderEvent } from "./provider.ts";

export interface PlanStore { get(key: string): Promise<string | null>; set(key: string, id: string): Promise<void> }
export interface RazorpayConfig { keyId: string; keySecret: string; webhookSecret: string; plans: PlanStore; fetch?: typeof fetch; baseUrl?: string }

const EVENTS: Record<string, ProviderEvent["type"]> = {
  "subscription.activated": "activated", "subscription.charged": "charged", "subscription.pending": "pending", "subscription.halted": "halted",
  "subscription.cancelled": "cancelled", "subscription.completed": "completed", "subscription.updated": "updated",
};

export class RazorpayProvider {
  name = "razorpay";
  private c: RazorpayConfig;
  private f: typeof fetch;
  private base: string;
  constructor(c: RazorpayConfig) { this.c = c; this.f = c.fetch ?? fetch; this.base = c.baseUrl ?? "https://api.razorpay.com/v1"; }

  supports(currency: string) { return currency === "INR"; }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.f(this.base + path, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { authorization: "Basic " + Buffer.from(`${this.c.keyId}:${this.c.keySecret}`).toString("base64"), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!res.ok) throw new ProviderError(res.status === 400 ? "PROVIDER_REJECTED" : "PROVIDER_ERROR", json?.error?.description ?? `razorpay returned ${res.status}`);
    return json;
  }

  // Plans have fixed amounts, and ours are custom per customer: create on demand, reuse when the same amount repeats.
  private async planFor(period: Period, currency: string, amountMinor: number): Promise<string> {
    const key = `${period}:${currency}:${amountMinor}`;
    const have = await this.c.plans.get(key);
    if (have) return have;
    const p = await this.api("POST", "/plans", { period: period === "annual" ? "yearly" : "monthly", interval: 1, item: { name: `Modulo ${period} plan`, amount: amountMinor, currency } });
    await this.c.plans.set(key, p.id);
    return p.id;
  }

  async createSubscription(i: Parameters<BillingProvider["createSubscription"]>[0]) {
    const plan = await this.planFor(i.period, i.currency, i.amountMinor);
    const s = await this.api("POST", "/subscriptions", { plan_id: plan, total_count: i.period === "annual" ? 10 : 120, quantity: 1, customer_notify: 1, notes: { tenant_id: i.tenantId } });
    return { providerSubId: s.id as string, checkout: { provider: "razorpay", keyId: this.c.keyId, subscriptionId: s.id, name: "Modulo", description: `${i.tenantName} subscription`, prefill: { email: i.email ?? undefined }, notes: { tenant_id: i.tenantId } } };
  }

  async changePlan(i: Parameters<BillingProvider["changePlan"]>[0]) {
    const plan = await this.planFor(i.period, i.currency, i.amountMinor);
    try { await this.api("PATCH", `/subscriptions/${i.providerSubId}`, { plan_id: plan, schedule_change_at: "cycle_end" }); }
    catch (e) { if (e instanceof ProviderError && e.code === "PROVIDER_REJECTED") throw new ProviderError("PLAN_CHANGE_UNSUPPORTED", e.message); throw e; }
  }

  async cancel(i: Parameters<BillingProvider["cancel"]>[0]) {
    await this.api("POST", `/subscriptions/${i.providerSubId}/cancel`, { cancel_at_cycle_end: i.atCycleEnd ? 1 : 0 });
  }

  // Signature = HMAC-SHA256 of the RAW body with the webhook secret you typed into the Razorpay dashboard.
  verifyWebhook(raw: Buffer, headers: Record<string, unknown>) {
    const sig = headers["x-razorpay-signature"];
    return typeof sig === "string" && safeEqualHex(sig, hmacHex(this.c.webhookSecret, raw));
  }

  parseWebhook(raw: Buffer, headers: Record<string, unknown>): ProviderEvent | null {
    const body = JSON.parse(raw.toString());
    const type = EVENTS[body.event];
    const sub = body.payload?.subscription?.entity;
    if (!type || !sub?.id) return null;
    const pay = body.payload?.payment?.entity;
    const secs = (x: unknown) => (typeof x === "number" ? new Date(x * 1000) : undefined);
    const hdr = headers["x-razorpay-event-id"];
    return {
      id: typeof hdr === "string" && hdr ? hdr : createHash("sha256").update(raw).digest("hex"),
      type, providerSubId: sub.id, createdAt: secs(body.created_at) ?? new Date(),
      paymentId: pay?.id, amountMinor: pay?.amount, currency: pay?.currency, periodStart: secs(sub.current_start), periodEnd: secs(sub.current_end),
    };
  }

  // Checkout "success" callback signature: HMAC(key_secret, payment_id + "|" + subscription_id). UX only; webhooks are the source of truth.
  verifyCheckout(i: { paymentId: string; subscriptionId: string; signature: string }) {
    return safeEqualHex(i.signature, hmacHex(this.c.keySecret, `${i.paymentId}|${i.subscriptionId}`));
  }
}
