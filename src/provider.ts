// Payment provider contract. The rest of the app only talks to this, never to Razorpay/Stripe directly.
import { createHmac, timingSafeEqual } from "node:crypto";

export type Period = "monthly" | "annual";

export interface ProviderEvent {
  id: string; // unique per event (idempotency key)
  type: "activated" | "charged" | "pending" | "halted" | "cancelled" | "completed" | "updated";
  providerSubId: string;
  createdAt: Date;
  paymentId?: string; amountMinor?: number; currency?: string;
  periodStart?: Date; periodEnd?: Date;
}

export class ProviderError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface BillingProvider {
  name: string;
  supports(currency: string): boolean;
  createSubscription(i: { tenantId: string; tenantName: string; email: string | null; currency: string; period: Period; amountMinor: number }): Promise<{ providerSubId: string; checkout: Record<string, unknown> }>;
  changePlan(i: { providerSubId: string; currency: string; period: Period; amountMinor: number }): Promise<void>; // always effective at cycle end
  cancel(i: { providerSubId: string; atCycleEnd: boolean }): Promise<void>;
  verifyWebhook(raw: Buffer, headers: Record<string, unknown>): boolean;
  parseWebhook(raw: Buffer, headers: Record<string, unknown>): ProviderEvent | null; // null = event we do not act on
  verifyCheckout(i: { paymentId: string; subscriptionId: string; signature: string }): boolean;
}

export const hmacHex = (secret: string, data: string | Buffer) => createHmac("sha256", secret).update(data).digest("hex");
export const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// In-memory provider for development, demos and tests. Never use in production.
export class FakeProvider {
  name = "fake";
  secret = "fake-webhook-secret";
  calls: { op: string; args: any }[] = [];
  failChange = false;
  private n = 0;

  supports(_currency: string) { return true; }
  async createSubscription(i: Parameters<BillingProvider["createSubscription"]>[0]) {
    const id = `fake_sub_${++this.n}_${Math.random().toString(36).slice(2, 8)}`;
    this.calls.push({ op: "create", args: i });
    return { providerSubId: id, checkout: { provider: "fake", subscriptionId: id, amountMinor: i.amountMinor, currency: i.currency } };
  }
  async changePlan(i: Parameters<BillingProvider["changePlan"]>[0]) {
    if (this.failChange) throw new ProviderError("PLAN_CHANGE_UNSUPPORTED", "this payment method does not allow plan changes");
    this.calls.push({ op: "change", args: i });
  }
  async cancel(i: Parameters<BillingProvider["cancel"]>[0]) { this.calls.push({ op: "cancel", args: i }); }
  sign(body: string) { return hmacHex(this.secret, body); }
  verifyWebhook(raw: Buffer, headers: Record<string, unknown>) {
    const s = headers["x-fake-signature"];
    return typeof s === "string" && safeEqualHex(s, this.sign(raw.toString()));
  }
  parseWebhook(raw: Buffer): ProviderEvent | null {
    const e = JSON.parse(raw.toString());
    const d = (x: unknown) => (x ? new Date(x as string | number) : undefined);
    return { id: e.id, type: e.type, providerSubId: e.subId, createdAt: new Date(e.createdAt), paymentId: e.paymentId, amountMinor: e.amountMinor, currency: e.currency, periodStart: d(e.periodStart), periodEnd: d(e.periodEnd) };
  }
  verifyCheckout(i: { paymentId: string; subscriptionId: string; signature: string }) {
    return safeEqualHex(i.signature, hmacHex(this.secret, `${i.paymentId}|${i.subscriptionId}`));
  }
  // test/demo helper: build a signed webhook request
  makeEvent(subId: string, type: ProviderEvent["type"], o: { id?: string; createdAt?: number; paymentId?: string; amountMinor?: number; currency?: string; periodStart?: number; periodEnd?: number } = {}) {
    const body = JSON.stringify({ id: o.id ?? `evt_${Math.random().toString(36).slice(2, 12)}`, type, subId, createdAt: o.createdAt ?? Date.now(), paymentId: o.paymentId, amountMinor: o.amountMinor, currency: o.currency, periodStart: o.periodStart, periodEnd: o.periodEnd });
    return { body, headers: { "content-type": "application/json", "x-fake-signature": this.sign(body) } };
  }
}
