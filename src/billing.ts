// Subscription billing: checkout, webhooks (the source of truth), cancel, dev simulator.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { withTenant, loadCatalog } from "./db.ts";
import type { Pool } from "./db.ts";
import { HttpError } from "./ctx.ts";
import type { Ctx } from "./ctx.ts";
import { price } from "./pricing.ts";
import { FakeProvider, ProviderError } from "./provider.ts";
import type { BillingProvider, ProviderEvent } from "./provider.ts";
import { syncModules } from "./entitlements.ts";
import type { PlanStore } from "./razorpay.ts";

export const dbPlanStore = (pool: Pool, provider: string): PlanStore => ({
  async get(key) { return (await pool.query("SELECT plan_id FROM provider_plans WHERE provider = $1 AND plan_key = $2", [provider, key])).rows[0]?.plan_id ?? null; },
  async set(key, id) { await pool.query("INSERT INTO provider_plans (provider, plan_key, plan_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [provider, key, id]); },
});

const toHttp = (e: unknown): never => {
  if (e instanceof ProviderError) throw new HttpError(e.code === "PLAN_CHANGE_UNSUPPORTED" ? 409 : 502, e.code, e.message);
  throw e;
};

// Apply one provider event to one tenant. Idempotent and tolerant of out-of-order delivery.
async function applyEvent(c: PoolClient, tenantId: string, ev: ProviderEvent): Promise<string> {
  const sub = (await c.query("SELECT * FROM subscriptions WHERE provider_sub_id = $1 FOR UPDATE", [ev.providerSubId])).rows[0];
  if (!sub) return "gone";

  if (ev.type === "charged" && ev.paymentId) { // money received is recorded even if the event is old
    const mods = (await c.query("SELECT module_id FROM tenant_modules WHERE disabled_at IS NULL ORDER BY module_id")).rows.map((r) => r.module_id);
    let lines: unknown = [];
    try { lines = price({ moduleIds: mods, seats: sub.seats, billing: sub.billing, currency: sub.currency }, await loadCatalog(c as any)).lines; } catch { /* catalog changed; keep empty */ }
    await c.query(
      `INSERT INTO platform_invoices (tenant_id, lines, total_minor, currency, status, provider_invoice_id, paid_at) VALUES ($1,$2,$3,$4,'paid',$5, now()) ON CONFLICT (provider_invoice_id) DO NOTHING`,
      [tenantId, JSON.stringify(lines), ev.amountMinor ?? sub.quoted_period_minor, ev.currency ?? sub.currency, ev.paymentId]);
  }
  if (sub.last_provider_event_at && ev.createdAt < sub.last_provider_event_at) return "stale"; // older than what we already know

  const set = async (status: string, providerStatus: string, extra = "", params: unknown[] = []) => {
    await c.query(`UPDATE subscriptions SET provider_status = $1, last_provider_event_at = $2 ${extra} WHERE id = $${params.length + 3}`, [providerStatus, ev.createdAt, ...params, sub.id]);
    await c.query("SELECT billing_set_status($1, $2)", [tenantId, status]);
  };

  switch (ev.type) {
    case "activated":
    case "charged": {
      const start = ev.periodStart ?? sub.period_start, end = ev.periodEnd ?? sub.period_end;
      const renewal = ev.type === "charged" && ev.periodStart && ev.periodStart.getTime() >= new Date(sub.period_end).getTime() - 60_000;
      if (renewal && sub.pending) { // a scheduled plan change starts with the new cycle
        const p = sub.pending;
        await syncModules(c, tenantId, p.moduleIds);
        await c.query("UPDATE subscriptions SET seats = $2, quoted_period_minor = $3, pending = NULL WHERE id = $1", [sub.id, p.seats, p.quotedPeriodMinor]);
        await c.query("INSERT INTO subscription_events (tenant_id, type, payload) VALUES ($1,'pending_change_applied',$2)", [tenantId, JSON.stringify(p)]);
      }
      await set("active", "active", ", period_start = $3, period_end = $4", [start, end]);
      break;
    }
    case "pending": await set("past_due", "pending"); break;     // payment failed, provider is retrying: keep access (grace)
    case "halted": await set("suspended", "halted"); break;      // retries exhausted: block modules
    case "cancelled":
    case "completed": await set("cancelled", "cancelled", ", pending = NULL"); break;
    case "updated": await c.query("UPDATE subscriptions SET last_provider_event_at = $1 WHERE id = $2", [ev.createdAt, sub.id]); break;
  }
  await c.query("INSERT INTO subscription_events (tenant_id, type, payload) VALUES ($1,$2,$3)", [tenantId, `provider.${ev.type}`, JSON.stringify({ eventId: ev.id, paymentId: ev.paymentId ?? null })]);
  return "applied";
}

export interface BillingDeps { provider: BillingProvider; devSimulate: boolean }

export function registerBilling(app: FastifyInstance, ctx: Ctx, deps: BillingDeps) {
  const { provider } = deps;
  const OWNER_ADMIN = ["owner", "admin"];

  app.post("/billing/checkout", async (req) => {
    const a = await ctx.authenticate(req);
    ctx.needRole(a, OWNER_ADMIN);
    const info = await withTenant(ctx.pool, a.tenantId, async (c) => {
      const sub = (await c.query("SELECT * FROM subscriptions")).rows[0];
      if (!sub) throw new HttpError(409, "NO_SUBSCRIPTION", "choose modules and seats first");
      if (sub.provider_sub_id && sub.provider_status === "active") throw new HttpError(409, "ALREADY_SUBSCRIBED", "subscription is already active");
      const mods = (await c.query("SELECT module_id FROM tenant_modules WHERE disabled_at IS NULL ORDER BY module_id")).rows.map((r) => r.module_id);
      return { sub, mods, name: (await c.query("SELECT name FROM current_tenant")).rows[0].name, email: (await c.query("SELECT email FROM tenant_users WHERE id = $1", [a.userId])).rows[0]?.email ?? null };
    });
    if (!provider.supports(info.sub.currency)) throw new HttpError(422, "CURRENCY_UNSUPPORTED", `${provider.name} cannot bill in ${info.sub.currency}`);
    const quote = price({ moduleIds: info.mods, seats: info.sub.seats, billing: info.sub.billing, currency: info.sub.currency }, await loadCatalog(ctx.pool)); // server decides the amount
    let res;
    try { res = await provider.createSubscription({ tenantId: a.tenantId, tenantName: info.name, email: info.email, currency: info.sub.currency, period: info.sub.billing, amountMinor: quote.periodTotal }); } catch (e) { return toHttp(e); }
    await withTenant(ctx.pool, a.tenantId, async (c) => {
      await c.query("UPDATE subscriptions SET provider = $1, provider_sub_id = $2, provider_status = 'created', quoted_period_minor = $3, cancel_at_period_end = false, pending = NULL, last_provider_event_at = NULL", [provider.name, res.providerSubId, quote.periodTotal]);
      await c.query("INSERT INTO subscription_events (tenant_id, type, payload) VALUES ($1,'checkout_started',$2)", [a.tenantId, JSON.stringify({ providerSubId: res.providerSubId, amountMinor: quote.periodTotal, by: a.userId })]);
    });
    return { checkout: res.checkout, amountMinor: quote.periodTotal, currency: info.sub.currency, quote };
  });

  // Checkout success callback signature check. Only for UX; access is granted by the webhook, never by this.
  app.post("/billing/verify", async (req) => {
    await ctx.authenticate(req);
    const b = z.object({ paymentId: z.string().max(100), subscriptionId: z.string().max(100), signature: z.string().max(200) }).strict().parse(req.body);
    return { verified: provider.verifyCheckout(b), note: "access is activated by the provider webhook" };
  });

  app.post("/billing/cancel", async (req) => {
    const a = await ctx.authenticate(req);
    ctx.needRole(a, ["owner"]);
    const b = z.object({ atCycleEnd: z.boolean().default(true) }).strict().parse(req.body ?? {});
    const sub = await withTenant(ctx.pool, a.tenantId, async (c) => (await c.query("SELECT * FROM subscriptions")).rows[0]);
    if (!sub?.provider_sub_id || !["active", "pending"].includes(sub.provider_status)) throw new HttpError(409, "NO_ACTIVE_SUBSCRIPTION", "nothing to cancel");
    try { await provider.cancel({ providerSubId: sub.provider_sub_id, atCycleEnd: b.atCycleEnd }); } catch (e) { return toHttp(e); }
    await withTenant(ctx.pool, a.tenantId, async (c) => {
      if (b.atCycleEnd) await c.query("UPDATE subscriptions SET cancel_at_period_end = true");
      await c.query("INSERT INTO subscription_events (tenant_id, type, payload) VALUES ($1,'cancel_requested',$2)", [a.tenantId, JSON.stringify({ atCycleEnd: b.atCycleEnd, by: a.userId })]);
    });
    return { ok: true, note: b.atCycleEnd ? "access continues until the current period ends" : "cancellation requested; confirmed by the provider webhook" };
  });

  // ---- webhook: public URL, raw body, signature first, then idempotent processing
  app.register(async (hook) => {
    hook.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1_000_000 }, (_req, body, done) => done(null, body));
    hook.post("/webhooks/:provider", async (req, reply) => {
      if ((req.params as any).provider !== provider.name) return reply.code(404).send({ error: "NOT_FOUND" });
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !provider.verifyWebhook(raw, req.headers)) return reply.code(400).send({ error: "BAD_SIGNATURE" });
      let ev: ProviderEvent | null;
      try { ev = provider.parseWebhook(raw, req.headers); } catch { return reply.code(400).send({ error: "BAD_PAYLOAD" }); }
      if (!ev) return { ok: true, ignored: true };
      const ins = await ctx.pool.query(
        `INSERT INTO webhook_events (provider, event_id, type, payload) VALUES ($1,$2,$3,$4)
         ON CONFLICT (provider, event_id) DO UPDATE SET received_at = now() WHERE webhook_events.processed_at IS NULL RETURNING event_id`,
        [provider.name, ev.id, ev.type, raw.toString()]);
      if (ins.rowCount === 0) return { ok: true, duplicate: true }; // already processed
      const done = (error: string | null) => ctx.pool.query("UPDATE webhook_events SET processed_at = CASE WHEN $3::text IS NULL OR $3 = 'unknown subscription' THEN now() ELSE NULL END, error = $3 WHERE provider = $1 AND event_id = $2", [provider.name, ev!.id, error]);
      const tenant = (await ctx.pool.query("SELECT billing_find_tenant($1, $2) AS t", [provider.name, ev.providerSubId])).rows[0].t as string | null;
      if (!tenant) { await done("unknown subscription"); return { ok: true, unknown: true }; } // ack: retrying will not help
      try {
        const result = await withTenant(ctx.pool, tenant, (c) => applyEvent(c, tenant, ev!));
        await done(null);
        return { ok: true, result };
      } catch (e: any) {
        await done(String(e?.message ?? e).slice(0, 300));
        throw e; // 500 => provider retries
      }
    });
  });

  // ---- dev/demo only: pretend to be the provider so the full flow works without a Razorpay account
  if (deps.devSimulate && provider instanceof FakeProvider) {
    app.post("/dev/billing/simulate", async (req, reply) => {
      const a = await ctx.authenticate(req);
      ctx.needRole(a, ["owner"]);
      const b = z.object({ type: z.enum(["activated", "charged", "pending", "halted", "cancelled"]), nextCycle: z.boolean().default(false), days: z.number().int().min(1).max(366).default(30) }).strict().parse(req.body);
      const sub = await withTenant(ctx.pool, a.tenantId, async (c) => (await c.query("SELECT * FROM subscriptions")).rows[0]);
      if (!sub?.provider_sub_id) throw new HttpError(409, "NO_CHECKOUT", "start checkout first");
      const start = b.nextCycle ? new Date(sub.period_end).getTime() : Date.now();
      const e = provider.makeEvent(sub.provider_sub_id, b.type, { paymentId: b.type === "charged" ? `fake_pay_${randomBytes(5).toString("hex")}` : undefined, amountMinor: sub.quoted_period_minor, currency: sub.currency, periodStart: start, periodEnd: start + b.days * 86_400_000 });
      const r = await app.inject({ method: "POST", url: "/webhooks/fake", payload: e.body, headers: e.headers });
      return reply.code(r.statusCode).send(r.json());
    });
  }
}
