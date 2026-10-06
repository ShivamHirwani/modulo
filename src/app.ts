import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import { randomBytes } from "node:crypto";
import { createPool, withTenant, loadCatalog } from "./db.ts";
import { hashPassword, verifyPassword, newToken, hashToken } from "./security.ts";
import { price, PricingError } from "./pricing.ts";
import { HttpError } from "./ctx.ts";
import type { Auth, Ctx } from "./ctx.ts";
import { registerCrm } from "./crm.ts";
import { registerQuotes } from "./quotes.ts";
import { registerInvoices } from "./invoices.ts";
import { registerOutputs } from "./outputs.ts";
import { registerBilling } from "./billing.ts";
import { FakeProvider, ProviderError } from "./provider.ts";
import type { BillingProvider } from "./provider.ts";
import { syncModules } from "./entitlements.ts";
import { ConsoleMailer, processOutbox } from "./mail.ts";
import type { Mailer, MailDeps } from "./mail.ts";
import type { PdfOptions } from "./pdf.ts";

declare module "fastify" {
  interface FastifyInstance { flushMail(limit?: number): Promise<number> }
}

export { HttpError };
const authOf = new WeakMap<object, Auth>();

const Email = z.string().trim().toLowerCase().email().max(254);
const Password = z.string().min(10, "min 10 characters").max(200);
const Currency = z.enum(["USD", "INR", "EUR"]);
const Billing = z.enum(["monthly", "annual"]);
const ModuleIds = z.array(z.string().min(1).max(40)).max(30);

const SignupBody = z.object({ companyName: z.string().trim().min(2).max(120), name: z.string().trim().min(1).max(120), email: Email, password: Password, currency: Currency.default("USD") }).strict();
const LoginBody = z.object({ email: Email, password: z.string().max(200), tenantSlug: z.string().max(80).optional() }).strict();
const QuoteBody = z.object({ moduleIds: ModuleIds, seats: z.number(), billing: Billing, currency: Currency }).strict();
const SubBody = z.object({ moduleIds: ModuleIds, seats: z.number(), billing: Billing }).strict(); // NO price field: server decides
const MemberBody = z.object({ name: z.string().trim().min(1).max(120), email: Email, password: Password, role: z.enum(["admin", "manager", "member", "viewer"]) }).strict();
const LeadBody = z.object({ name: z.string().trim().min(1).max(120), email: Email, company: z.string().max(120).optional(), teamSize: z.string().max(40).optional(), message: z.string().max(2000).optional() }).strict();
const DeptBody = z.object({ name: z.string().trim().min(1).max(120), parentId: z.string().uuid().optional(), budgetMinor: z.number().int().nonnegative().optional() }).strict();
const AssetBody = z.object({ tag: z.string().trim().min(1).max(60), name: z.string().trim().min(1).max(160), category: z.string().max(80).optional(), departmentId: z.string().uuid().optional(), assignedUserId: z.string().uuid().optional() }).strict();

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "co";

export interface AppOptions {
  databaseUrl: string;
  rateLimitMax?: number; // auth endpoints per minute per IP
  mailer?: Mailer; // default: logs only, sends nothing
  mailFrom?: string; // envelope address on YOUR verified domain (SPF/DKIM)
  mailWorkerMs?: number; // poll interval; omit to disable the background worker (tests call app.flushMail())
  pdf?: PdfOptions; // optional TTF paths for non-Latin text and the rupee symbol
  billing?: (pool: import("./db.ts").Pool) => BillingProvider; // default: FakeProvider (dev only!)
  billingDevSimulate?: boolean; // exposes POST /dev/billing/simulate (fake provider only)
  logger?: boolean;
  corsOrigins?: string[]; // browser origins allowed to call the API (exact match). Empty = no cross-origin browser access
  trustProxy?: boolean; // true when behind a proxy that sets X-Forwarded-For (Render, Vercel, Cloudflare). Never true when exposed directly
  poolMax?: number;
  logStream?: { write(chunk: string): void }; // tests only
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ? { redact: ["req.headers.authorization", "req.headers.cookie"], ...(opts.logStream ? { stream: opts.logStream } : {}) } : false, bodyLimit: 100_000, trustProxy: opts.trustProxy ?? false });
  const pool = createPool(opts.databaseUrl, opts.poolMax);
  app.addHook("onClose", async () => { await pool.end(); });
  const allowed = new Set(opts.corsOrigins ?? []);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)), // no Origin header = not a browser; allowed
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["authorization", "content-type", "idempotency-key"], maxAge: 600, credentials: false,
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer").header("strict-transport-security", "max-age=15552000");
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });
  await app.register(rateLimit, { global: false });
  const authLimit = { rateLimit: { max: opts.rateLimitMax ?? 10, timeWindow: "1 minute" } };

  // ---------- errors ----------
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: "VALIDATION", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof PricingError) return reply.code(err.code === "ENTERPRISE_REQUIRED" ? 422 : 400).send({ error: err.code, message: err.message });
    if (err?.code === "MD001") return reply.code(409).send({ error: "LOCKED", message: err.message });
    if (err?.code === "MD002") return reply.code(409).send({ error: "INVALID_STATE", message: err.message });
    if (err?.code === "MD003") return reply.code(409).send({ error: "APPEND_ONLY", message: err.message });
    if (err?.code === "23505") return reply.code(409).send({ error: "CONFLICT", message: "already exists" });
    if (err?.code === "23503") return reply.code(422).send({ error: "INVALID_REFERENCE", message: "referenced record not found" });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code ?? "ERROR", message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: "INTERNAL" });
  });

  // ---------- guards ----------
  async function authenticate(req: FastifyRequest): Promise<Auth> {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) throw new HttpError(401, "UNAUTHENTICATED");
    const { rows } = await pool.query("SELECT * FROM auth_session_get($1)", [hashToken(h.slice(7))]);
    const r = rows[0];
    if (!r) throw new HttpError(401, "UNAUTHENTICATED");
    const a: Auth = { userId: r.out_user, tenantId: r.out_tenant, role: r.out_role, status: r.out_status, trialEnds: r.out_trial_ends };
    authOf.set(req, a);
    return a;
  }
  const needRole = (a: Auth, roles: string[]) => {
    if (!roles.includes(a.role)) throw new HttpError(403, "FORBIDDEN_ROLE", "your role cannot do this");
  };
  // Account must be live + module entitled. This is THE gate for every paid module route.
  async function needModule(a: Auth, moduleId: string) {
    if (a.status === "suspended" || a.status === "cancelled") throw new HttpError(402, "ACCOUNT_INACTIVE");
    if (a.status === "trial" && a.trialEnds && a.trialEnds < new Date()) throw new HttpError(402, "TRIAL_ENDED");
    const ok = await withTenant(pool, a.tenantId, async (c) => {
      const r = await c.query("SELECT 1 FROM tenant_modules WHERE module_id = $1 AND disabled_at IS NULL", [moduleId]);
      return r.rowCount === 1;
    });
    if (!ok) throw new HttpError(403, "MODULE_NOT_ENABLED", `module '${moduleId}' is not in your subscription`);
  }

  // ---------- public ----------
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/catalog", async () => ({ modules: await loadCatalog(pool) }));

  app.post("/pricing/quote", async (req) => {
    const b = QuoteBody.parse(req.body);
    return price(b, await loadCatalog(pool));
  });

  app.post("/enterprise/inquiry", { config: authLimit }, async (req, reply) => {
    const b = LeadBody.parse(req.body);
    await pool.query("INSERT INTO enterprise_leads (name,email,company,team_size,message) VALUES ($1,$2,$3,$4,$5)", [b.name, b.email, b.company ?? null, b.teamSize ?? null, b.message ?? null]);
    return reply.code(201).send({ ok: true });
  });

  // ---------- auth ----------
  async function startSession(userId: string, tenantId: string) {
    const { token, hash } = newToken();
    await pool.query("SELECT auth_session_create($1,$2,$3,$4::interval)", [hash, userId, tenantId, "30 days"]);
    return token;
  }

  app.post("/auth/signup", { config: authLimit }, async (req, reply) => {
    const b = SignupBody.parse(req.body);
    const pw = await hashPassword(b.password);
    const slug = `${slugify(b.companyName)}-${randomBytes(3).toString("hex")}`;
    const { rows } = await pool.query("SELECT * FROM auth_signup($1,$2,$3,$4,$5,$6)", [b.companyName, slug, b.currency, b.name, b.email, pw]);
    const token = await startSession(rows[0].out_user, rows[0].out_tenant);
    return reply.code(201).send({ token, tenant: { id: rows[0].out_tenant, slug }, role: "owner", trialDays: 14 });
  });

  app.post("/auth/login", { config: authLimit }, async (req) => {
    const b = LoginBody.parse(req.body);
    const { rows } = await pool.query("SELECT * FROM auth_login_lookup($1)", [b.email]);
    const ok = await verifyPassword(b.password, rows[0]?.out_hash ?? null);
    if (!rows[0] || !ok) throw new HttpError(401, "INVALID_CREDENTIALS", "email or password is wrong");
    const ms = (await pool.query("SELECT * FROM auth_user_memberships($1)", [rows[0].out_user])).rows;
    const m = b.tenantSlug ? ms.find((x) => x.out_slug === b.tenantSlug) : ms[0];
    if (!m) throw new HttpError(403, "NO_TENANT", "no matching workspace");
    return { token: await startSession(rows[0].out_user, m.out_tenant), tenant: { id: m.out_tenant, slug: m.out_slug }, role: m.out_role };
  });

  app.post("/auth/logout", async (req) => {
    await authenticate(req);
    await pool.query("SELECT auth_session_delete($1)", [hashToken(req.headers.authorization!.slice(7))]);
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const a = await authenticate(req);
    const t = await withTenant(pool, a.tenantId, async (c) => (await c.query("SELECT * FROM current_tenant")).rows[0]);
    return { userId: a.userId, role: a.role, tenant: t };
  });

  // ---------- team (seat-limited) ----------
  app.post("/team/members", async (req, reply) => {
    const a = await authenticate(req);
    needRole(a, ["owner", "admin"]);
    const b = MemberBody.parse(req.body);
    const pw = await hashPassword(b.password);
    const id = await withTenant(pool, a.tenantId, async (c) => {
      const sub = await c.query("SELECT LEAST(seats, COALESCE((pending->>'seats')::int, seats)) AS seats FROM subscriptions FOR UPDATE"); // lock: no race past seat limit; a scheduled downgrade lowers the cap now
      if (!sub.rows[0]) throw new HttpError(409, "NO_SUBSCRIPTION", "choose a plan first");
      const n = (await c.query("SELECT count(*)::int AS n FROM memberships WHERE active")).rows[0].n;
      if (n >= sub.rows[0].seats) throw new HttpError(409, "SEAT_LIMIT", "all seats are used; increase seats first");
      return (await c.query("SELECT auth_add_member($1,$2,$3,$4,$5) AS id", [a.tenantId, b.name, b.email, pw, b.role])).rows[0].id;
    });
    return reply.code(201).send({ userId: id });
  });

  // ---------- subscription ----------
  app.get("/subscription", async (req) => {
    const a = await authenticate(req);
    return withTenant(pool, a.tenantId, async (c) => {
      const s = (await c.query("SELECT billing, seats, period_start, period_end, currency, quoted_period_minor, provider, provider_status, cancel_at_period_end, pending FROM subscriptions")).rows[0] ?? null;
      const mods = (await c.query("SELECT module_id FROM tenant_modules WHERE disabled_at IS NULL ORDER BY module_id")).rows.map((r) => r.module_id);
      const used = (await c.query("SELECT count(*)::int AS n FROM memberships WHERE active")).rows[0].n;
      const trialEnds = a.trialEnds ? a.trialEnds.toISOString() : null;
      const daysLeft = a.status === "trial" && a.trialEnds ? Math.max(0, Math.ceil((a.trialEnds.getTime() - Date.now()) / 86_400_000)) : null;
      return { subscription: s, modules: mods, seatsUsed: used, status: a.status, trialEndsAt: trialEnds, trialDaysLeft: daysLeft, needsPayment: a.status === "trial" || a.status === "suspended" || a.status === "cancelled" };
    });
  });

  // Trial/unpaid: changes apply immediately. Paid: changes are scheduled for the next renewal (no free mid-cycle usage).
  app.put("/subscription", async (req) => {
    const a = await authenticate(req);
    needRole(a, ["owner", "admin"]);
    if (a.status === "cancelled") throw new HttpError(402, "ACCOUNT_INACTIVE");
    const b = SubBody.parse(req.body);
    const catalog = await loadCatalog(pool);
    const plan = await withTenant(pool, a.tenantId, async (c) => {
      const cur = (await c.query("SELECT currency FROM current_tenant")).rows[0].currency.trim();
      const quote = price({ ...b, currency: cur }, catalog); // server-side price; throws on bad input
      const ids = [...new Set(b.moduleIds)];
      const sub = (await c.query("SELECT * FROM subscriptions FOR UPDATE")).rows[0];
      await c.query("SELECT 1 FROM memberships WHERE active FOR UPDATE");
      const used = (await c.query("SELECT count(*)::int AS n FROM memberships WHERE active")).rows[0].n;
      if (b.seats < used) throw new HttpError(409, "SEATS_BELOW_MEMBERS", `${used} active users; remove users or choose more seats`);
      if (sub?.provider_sub_id && ["active", "pending"].includes(sub.provider_status)) {
        if (b.billing !== sub.billing) throw new HttpError(422, "BILLING_PERIOD_LOCKED", "switching monthly/annual needs support; cancel and resubscribe");
        const curIds = (await c.query("SELECT module_id FROM tenant_modules WHERE disabled_at IS NULL ORDER BY module_id")).rows.map((r) => r.module_id);
        const same = b.seats === sub.seats && curIds.length === ids.length && ids.every((i) => curIds.includes(i));
        return { mode: "scheduled" as const, providerSubId: sub.provider_sub_id as string, quote, ids, cur, periodEnd: sub.period_end as Date, same };
      }
      await c.query(
        `INSERT INTO subscriptions (tenant_id, billing, seats, period_start, period_end, quoted_period_minor, currency)
         VALUES ($1,$2,$3, now(), now() + CASE WHEN $2='annual' THEN interval '1 year' ELSE interval '1 month' END, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET billing=EXCLUDED.billing, seats=EXCLUDED.seats, quoted_period_minor=EXCLUDED.quoted_period_minor, currency=EXCLUDED.currency,
           provider = CASE WHEN subscriptions.provider_status = 'created' THEN NULL ELSE subscriptions.provider END,
           provider_sub_id = CASE WHEN subscriptions.provider_status = 'created' THEN NULL ELSE subscriptions.provider_sub_id END,
           provider_status = CASE WHEN subscriptions.provider_status = 'created' THEN NULL ELSE subscriptions.provider_status END`, // an unpaid checkout is stale once the selection changes
        [a.tenantId, b.billing, b.seats, quote.periodTotal, cur],
      );
      await syncModules(c, a.tenantId, ids);
      await c.query("INSERT INTO subscription_events (tenant_id, type, payload) VALUES ($1,'subscription_changed',$2)", [a.tenantId, JSON.stringify({ by: a.userId, ...b, quote })]);
      return { mode: "immediate" as const, quote };
    });
    if (plan.mode === "immediate") return { quote: plan.quote, note: "Applied now (trial). Pay to keep access after the trial." };
    // paid subscription: provider first (it may refuse), then record the pending change
    try { await billing.changePlan({ providerSubId: plan.providerSubId, currency: plan.cur, period: b.billing, amountMinor: plan.quote.periodTotal }); }
    catch (e) { if (e instanceof ProviderError) throw new HttpError(e.code === "PLAN_CHANGE_UNSUPPORTED" ? 409 : 502, e.code, e.message); throw e; }
    await withTenant(pool, a.tenantId, async (c) => {
      const pending = plan.same ? null : { moduleIds: plan.ids, seats: b.seats, quotedPeriodMinor: plan.quote.periodTotal };
      await c.query("UPDATE subscriptions SET pending = $1", [pending ? JSON.stringify(pending) : null]);
      await c.query("INSERT INTO subscription_events (tenant_id, type, payload) VALUES ($1,'change_scheduled',$2)", [a.tenantId, JSON.stringify({ by: a.userId, ...b, pending })]);
    });
    return { quote: plan.quote, scheduled: !plan.same, effectiveAt: plan.periodEnd, note: plan.same ? "Scheduled change cleared." : "Takes effect at your next renewal." };
  });

  // ---------- module: departments ----------
  app.get("/departments", async (req) => {
    const a = await authenticate(req);
    await needModule(a, "dept");
    return withTenant(pool, a.tenantId, async (c) => ({ items: (await c.query("SELECT id, name, parent_id, budget_minor FROM departments ORDER BY name")).rows }));
  });
  app.post("/departments", async (req, reply) => {
    const a = await authenticate(req);
    needRole(a, ["owner", "admin", "manager"]);
    await needModule(a, "dept");
    const b = DeptBody.parse(req.body);
    const row = await withTenant(pool, a.tenantId, async (c) =>
      (await c.query("INSERT INTO departments (tenant_id, name, parent_id, budget_minor) VALUES ($1,$2,$3,$4) RETURNING id, name, parent_id, budget_minor", [a.tenantId, b.name, b.parentId ?? null, b.budgetMinor ?? null])).rows[0]);
    return reply.code(201).send(row);
  });

  // ---------- module: assets ----------
  app.get("/assets", async (req) => {
    const a = await authenticate(req);
    await needModule(a, "assets");
    return withTenant(pool, a.tenantId, async (c) => ({ items: (await c.query("SELECT id, tag, name, category, status, department_id, assigned_user_id FROM assets ORDER BY tag")).rows }));
  });
  app.post("/assets", async (req, reply) => {
    const a = await authenticate(req);
    needRole(a, ["owner", "admin", "manager"]);
    await needModule(a, "assets");
    const b = AssetBody.parse(req.body);
    const row = await withTenant(pool, a.tenantId, async (c) =>
      (await c.query(
        `INSERT INTO assets (tenant_id, tag, name, category, department_id, assigned_user_id, status)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6::uuid IS NULL THEN 'in_stock' ELSE 'assigned' END)
         RETURNING id, tag, name, category, status, department_id, assigned_user_id`,
        [a.tenantId, b.tag, b.name, b.category ?? null, b.departmentId ?? null, b.assignedUserId ?? null],
      )).rows[0]);
    return reply.code(201).send(row);
  });

  const billing: BillingProvider = opts.billing ? opts.billing(pool) : (new FakeProvider() as unknown as BillingProvider);
  const ctx: Ctx = { pool, authenticate, needRole, needModule };
  registerCrm(app, ctx);
  registerQuotes(app, ctx);
  registerInvoices(app, ctx);

  const mail: MailDeps = { pool, mailer: opts.mailer ?? new ConsoleMailer(), from: opts.mailFrom ?? "noreply@localhost", pdf: opts.pdf ?? {} };
  app.decorate("flushMail", (limit?: number) => processOutbox(mail, limit));
  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.mailWorkerMs) {
    timer = setInterval(() => { processOutbox(mail).catch((e) => app.log.error(e)); }, opts.mailWorkerMs);
    timer.unref();
    app.addHook("onClose", async () => { clearInterval(timer); });
  }
  const kick = () => { if (opts.mailWorkerMs) setImmediate(() => { processOutbox(mail).catch((e) => app.log.error(e)); }); };
  registerOutputs(app, ctx, { mail, kick });
  registerBilling(app, ctx, { provider: billing, devSimulate: opts.billingDevSimulate ?? false });

  return app;
}
