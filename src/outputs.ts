// PDF download, email-a-document (queued), email history/retry, seller profile settings.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "./db.ts";
import { HttpError, WRITE, FINANCE } from "./ctx.ts";
import type { Ctx } from "./ctx.ts";
import { Id, audit } from "./documents.ts";
import { renderPdf } from "./pdf.ts";
import { loadRenderData } from "./render-data.ts";
import { subjectFor } from "./mail.ts";
import type { MailDeps } from "./mail.ts";

const Email = z.string().trim().toLowerCase().email().max(254);
const EmailBody = z.object({ to: z.array(Email).min(1).max(5).optional(), cc: z.array(Email).max(5).optional(), message: z.string().max(2000).optional() }).strict();
const ProfileBody = z.object({
  legalName: z.string().trim().max(160).nullable().optional(), address: z.string().max(400).nullable().optional(), taxId: z.string().max(40).nullable().optional(),
  email: Email.nullable().optional(), phone: z.string().max(40).nullable().optional(), paymentInstructions: z.string().max(800).nullable().optional(), footerNote: z.string().max(800).nullable().optional(),
}).strict();
const ListQuery = z.object({ quoteId: Id.optional(), invoiceId: Id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

const TRIAL_DAILY = 20, PAID_DAILY = 200;
const SENDABLE: Record<"quote" | "invoice", string[]> = { quote: ["sent", "accepted", "converted"], invoice: ["sent", "partial", "paid"] };

export function registerOutputs(app: FastifyInstance, ctx: Ctx, deps: { mail: MailDeps; kick: () => void }) {
  const idOf = (req: any) => Id.parse(req.params.id);

  for (const kind of ["quote", "invoice"] as const) {
    const base = kind === "quote" ? "/quotes" : "/invoices";
    const moduleId = kind === "quote" ? "quote" : "bill";
    const roles = kind === "quote" ? WRITE : FINANCE;

    app.get(`${base}/:id/pdf`, async (req, reply) => {
      const a = await ctx.authenticate(req);
      await ctx.needModule(a, moduleId);
      const id = idOf(req);
      const L = await withTenant(ctx.pool, a.tenantId, (c) => loadRenderData(c, kind, id));
      const buf = await renderPdf(L.pdf, deps.mail.pdf);
      const name = `${kind === "invoice" ? "Invoice" : "Quotation"}-${L.pdf.number ?? "DRAFT"}.pdf`.replace(/[^A-Za-z0-9._-]+/g, "_");
      return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${name}"`).header("cache-control", "private, no-store").send(buf);
    });

    app.post(`${base}/:id/email`, async (req, reply) => {
      const a = await ctx.authenticate(req);
      ctx.needRole(a, roles);
      await ctx.needModule(a, moduleId);
      const id = idOf(req), b = EmailBody.parse(req.body ?? {});
      const out = await withTenant(ctx.pool, a.tenantId, async (c) => {
        const L = await loadRenderData(c, kind, id); // 404 if not ours
        if (!SENDABLE[kind].includes(L.storedStatus)) throw new HttpError(409, "NOT_SENT", `a ${L.storedStatus} ${kind} cannot be emailed; send it first`);
        const to = [...new Set(b.to ?? (L.defaultTo ? [L.defaultTo.trim().toLowerCase()] : []))];
        if (to.length === 0) throw new HttpError(422, "NO_RECIPIENT", "no email on the contact or company; pass `to`");
        const cc = [...new Set(b.cc ?? [])].filter((x) => !to.includes(x));
        const sentToday = (await c.query("SELECT count(*)::int AS n FROM email_outbox WHERE created_at > now() - interval '24 hours'")).rows[0].n;
        if (sentToday >= (a.status === "trial" ? TRIAL_DAILY : PAID_DAILY)) throw new HttpError(429, "EMAIL_LIMIT", "daily email limit reached");
        const col = kind === "quote" ? "quote_id" : "invoice_id";
        const dup = (await c.query(`SELECT id FROM email_outbox WHERE ${col} = $1 AND to_emails = $2::text[] AND created_at > now() - interval '60 seconds' AND status <> 'failed' LIMIT 1`, [id, to])).rows[0];
        if (dup) return { status: 200, body: { emailId: dup.id, to, cc, duplicate: true } };
        const subject = subjectFor(kind, L.pdf.number, L.pdf.version, L.sellerName);
        const row = (await c.query(`INSERT INTO email_outbox (tenant_id, ${col}, to_emails, cc_emails, subject, message, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [a.tenantId, id, to, cc, subject, b.message ?? null, a.userId])).rows[0];
        await audit(c, a, `${kind}.email`, kind, id, { to, cc, emailId: row.id });
        return { status: 202, body: { emailId: row.id, to, cc, status: "queued", duplicate: false } };
      });
      if (out.status === 202) deps.kick();
      return reply.code(out.status).send(out.body);
    });
  }

  app.get("/emails", async (req) => {
    const a = await ctx.authenticate(req);
    const q = ListQuery.parse(req.query);
    return withTenant(ctx.pool, a.tenantId, async (c) => ({
      items: (await c.query(
        `SELECT id, quote_id, invoice_id, to_emails, cc_emails, subject, status, attempts, last_error, sent_at, created_at FROM email_outbox
          WHERE ($1::uuid IS NULL OR quote_id = $1) AND ($2::uuid IS NULL OR invoice_id = $2) ORDER BY created_at DESC LIMIT $3`, [q.quoteId ?? null, q.invoiceId ?? null, q.limit])).rows
        .map((r) => ({ id: r.id, quoteId: r.quote_id, invoiceId: r.invoice_id, to: r.to_emails, cc: r.cc_emails, subject: r.subject, status: r.status, attempts: r.attempts, lastError: r.last_error, sentAt: r.sent_at, createdAt: r.created_at })),
    }));
  });

  app.post("/emails/:id/retry", async (req) => {
    const a = await ctx.authenticate(req);
    ctx.needRole(a, FINANCE);
    const id = idOf(req);
    const r = await withTenant(ctx.pool, a.tenantId, async (c) =>
      (await c.query("UPDATE email_outbox SET status = 'queued', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 AND status = 'failed' RETURNING id", [id])).rowCount);
    if (!r) throw new HttpError(409, "INVALID_STATE", "only failed emails can be retried");
    deps.kick();
    return { ok: true };
  });

  // ---- seller profile (printed on every PDF)
  const fmtProfile = (p: any, name: string) => ({ legalName: p?.legal_name ?? null, defaultName: name, address: p?.address ?? null, taxId: p?.tax_id ?? null, email: p?.email ?? null, phone: p?.phone ?? null, paymentInstructions: p?.payment_instructions ?? null, footerNote: p?.footer_note ?? null });
  app.get("/settings/profile", async (req) => {
    const a = await ctx.authenticate(req);
    return withTenant(ctx.pool, a.tenantId, async (c) => fmtProfile((await c.query("SELECT * FROM tenant_profile")).rows[0], (await c.query("SELECT name FROM current_tenant")).rows[0].name));
  });
  app.put("/settings/profile", async (req) => {
    const a = await ctx.authenticate(req);
    ctx.needRole(a, ["owner", "admin"]);
    const b = ProfileBody.parse(req.body);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      const cur = (await c.query("SELECT * FROM tenant_profile")).rows[0] ?? {};
      const pick = (k: keyof typeof b, col: string) => (k in b ? (b[k] as any) : cur[col] ?? null);
      await c.query(
        `INSERT INTO tenant_profile (tenant_id, legal_name, address, tax_id, email, phone, payment_instructions, footer_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id) DO UPDATE SET legal_name=EXCLUDED.legal_name, address=EXCLUDED.address, tax_id=EXCLUDED.tax_id, email=EXCLUDED.email, phone=EXCLUDED.phone, payment_instructions=EXCLUDED.payment_instructions, footer_note=EXCLUDED.footer_note, updated_at=now()`,
        [a.tenantId, pick("legalName", "legal_name"), pick("address", "address"), pick("taxId", "tax_id"), pick("email", "email"), pick("phone", "phone"), pick("paymentInstructions", "payment_instructions"), pick("footerNote", "footer_note")]);
      return fmtProfile((await c.query("SELECT * FROM tenant_profile")).rows[0], (await c.query("SELECT name FROM current_tenant")).rows[0].name);
    });
  });
}
