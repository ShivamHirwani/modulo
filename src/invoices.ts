// Module "bill": draft -> sent (number assigned, locked) -> partial/paid | void. Payments append-only.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "./db.ts";
import { HttpError, WRITE, FINANCE } from "./ctx.ts";
import type { Ctx } from "./ctx.ts";
import { Id, DateStr, CurrencyZ, ItemsSchema, replaceItems, nextNumber, audit, getInvoice, INVOICE_SQL, fmtInvoice } from "./documents.ts";

const InvoiceBody = z.object({ companyId: Id, currency: CurrencyZ.optional(), issueDate: DateStr.optional(), dueDate: DateStr.optional(), items: ItemsSchema.default([]) }).strict();
const InvoiceUpdate = InvoiceBody.partial().strict();
const PayBody = z.object({ amountMinor: z.number().int().positive().max(1e13), method: z.string().trim().max(40).optional() }).strict();
const ListQuery = z.object({ status: z.enum(["draft", "sent", "partial", "paid", "overdue", "void"]).optional(), companyId: Id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) });

const idOf = (req: any) => Id.parse(req.params.id);
const lock = async (c: any, id: string) => {
  const r = (await c.query("SELECT * FROM customer_invoices WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!r) throw new HttpError(404, "NOT_FOUND");
  return r;
};

export function registerInvoices(app: FastifyInstance, ctx: Ctx) {
  const guard = async (req: any, roles?: string[]) => {
    const a = await ctx.authenticate(req);
    if (roles) ctx.needRole(a, roles);
    await ctx.needModule(a, "bill");
    return a;
  };

  app.post("/invoices", async (req, reply) => {
    const a = await guard(req, WRITE);
    const b = InvoiceBody.parse(req.body);
    if (b.issueDate && b.dueDate && b.dueDate < b.issueDate) throw new HttpError(400, "VALIDATION", "dueDate is before issueDate");
    const out = await withTenant(ctx.pool, a.tenantId, async (c) => {
      const cur = b.currency ?? (await c.query("SELECT currency FROM current_tenant")).rows[0].currency;
      const id = (await c.query("INSERT INTO customer_invoices (tenant_id, company_id, currency, issue_date, due_date) VALUES ($1,$2,$3, COALESCE($4::date, current_date), COALESCE($5::date, COALESCE($4::date, current_date) + 14)) RETURNING id", [a.tenantId, b.companyId, cur, b.issueDate ?? null, b.dueDate ?? null])).rows[0].id;
      await replaceItems(c, "invoice", a.tenantId, id, b.items);
      await audit(c, a, "invoice.create", "invoice", id);
      return getInvoice(c, id);
    });
    return reply.code(201).send(out);
  });

  app.get("/invoices", async (req) => {
    const a = await guard(req);
    const q = ListQuery.parse(req.query);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      const rows = (await c.query(
        `SELECT * FROM (${INVOICE_SQL}) s WHERE ($1::text IS NULL OR eff_status = $1) AND ($2::uuid IS NULL OR company_id = $2) ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
        [q.status ?? null, q.companyId ?? null, q.limit, q.offset])).rows;
      return { items: rows.map((r) => fmtInvoice(r)) };
    });
  });

  app.get("/invoices/:id", async (req) => {
    const a = await guard(req);
    return withTenant(ctx.pool, a.tenantId, (c) => getInvoice(c, idOf(req)));
  });

  app.put("/invoices/:id", async (req) => {
    const a = await guard(req, WRITE);
    const id = idOf(req), b = InvoiceUpdate.parse(req.body);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      if ((await lock(c, id)).status !== "draft") throw new HttpError(409, "NOT_DRAFT", "sent invoices are locked");
      await c.query("UPDATE customer_invoices SET company_id = COALESCE($2, company_id), currency = COALESCE($3, currency), issue_date = COALESCE($4::date, issue_date), due_date = COALESCE($5::date, due_date) WHERE id = $1", [id, b.companyId ?? null, b.currency ?? null, b.issueDate ?? null, b.dueDate ?? null]);
      if (b.items) await replaceItems(c, "invoice", a.tenantId, id, b.items);
      const r = (await c.query("SELECT issue_date, due_date FROM customer_invoices WHERE id = $1", [id])).rows[0];
      if (r.due_date < r.issue_date) throw new HttpError(400, "VALIDATION", "dueDate is before issueDate");
      return getInvoice(c, id);
    });
  });

  app.delete("/invoices/:id", async (req) => {
    const a = await guard(req, WRITE);
    const id = idOf(req);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      if ((await lock(c, id)).status !== "draft") throw new HttpError(409, "NOT_DRAFT", "only drafts can be deleted; void sent invoices");
      await c.query("DELETE FROM customer_invoices WHERE id = $1", [id]);
      await audit(c, a, "invoice.delete", "invoice", id);
      return { ok: true };
    });
  });

  app.post("/invoices/:id/send", async (req) => {
    const a = await guard(req, FINANCE);
    const id = idOf(req);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      const inv = await lock(c, id);
      if (inv.status !== "draft") throw new HttpError(409, "INVALID_STATE", "only drafts can be sent");
      if (!inv.company_id) throw new HttpError(409, "EMPTY_DOCUMENT", "invoice needs a customer");
      if (!(inv.total_minor > 0)) throw new HttpError(409, "EMPTY_DOCUMENT", "invoice total must be above zero");
      const number = await nextNumber(c, a.tenantId, "invoice", "INV"); // assigned at send => no gaps from deleted drafts
      await c.query("UPDATE customer_invoices SET status = 'sent', number = $2 WHERE id = $1", [id, number]);
      await audit(c, a, "invoice.send", "invoice", id, { number });
      return getInvoice(c, id);
    });
  });

  app.post("/invoices/:id/void", async (req) => {
    const a = await guard(req, FINANCE);
    const id = idOf(req);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      const inv = await lock(c, id);
      if (inv.status !== "sent") throw new HttpError(409, "INVALID_STATE", "only sent invoices with no payments can be voided");
      await c.query("UPDATE customer_invoices SET status = 'void' WHERE id = $1", [id]);
      await audit(c, a, "invoice.void", "invoice", id);
      return getInvoice(c, id);
    });
  });

  // Record a payment. Send an Idempotency-Key header to make retries safe.
  app.post("/invoices/:id/payments", async (req, reply) => {
    const a = await guard(req, FINANCE);
    const id = idOf(req), b = PayBody.parse(req.body);
    const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].slice(0, 100) : null;
    const { replay, body } = await withTenant(ctx.pool, a.tenantId, async (c) => {
      const inv = await lock(c, id);
      if (key) {
        const ex = (await c.query("SELECT id, invoice_id, amount_minor FROM payments WHERE idempotency_key = $1", [key])).rows[0];
        if (ex) {
          if (ex.invoice_id !== id || ex.amount_minor !== b.amountMinor) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "key used for a different payment");
          return { replay: true, body: { paymentId: ex.id, invoice: await getInvoice(c, id) } };
        }
      }
      if (!["sent", "partial"].includes(inv.status)) throw new HttpError(409, "INVALID_STATE", "payments are only accepted on sent or partially paid invoices");
      const paid = (await c.query("SELECT COALESCE(sum(amount_minor),0) AS s FROM payments WHERE invoice_id = $1", [id])).rows[0].s;
      const balance = inv.total_minor - paid;
      if (b.amountMinor > balance) throw new HttpError(422, "OVERPAYMENT", `balance is ${balance}`);
      const pid = (await c.query("INSERT INTO payments (tenant_id, invoice_id, amount_minor, method, idempotency_key, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [a.tenantId, id, b.amountMinor, b.method ?? null, key, a.userId])).rows[0].id;
      await c.query("UPDATE customer_invoices SET status = $2 WHERE id = $1", [id, paid + b.amountMinor >= inv.total_minor ? "paid" : "partial"]);
      await audit(c, a, "payment.record", "invoice", id, { paymentId: pid, amountMinor: b.amountMinor });
      return { replay: false, body: { paymentId: pid, invoice: await getInvoice(c, id) } };
    });
    return reply.code(replay ? 200 : 201).send({ ...body, replay });
  });

  app.get("/billing/summary", async (req) => {
    const a = await guard(req);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      const out = (await c.query(
        `WITH inv AS (SELECT i.currency, i.due_date, i.total_minor - COALESCE(p.paid, 0) AS bal
                        FROM customer_invoices i LEFT JOIN (SELECT invoice_id, sum(amount_minor) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
                       WHERE i.status IN ('sent','partial'))
         SELECT currency, sum(bal) AS outstanding, COALESCE(sum(bal) FILTER (WHERE due_date < current_date), 0) AS overdue FROM inv GROUP BY currency`)).rows;
      const paid = (await c.query("SELECT i.currency, sum(p.amount_minor) AS s FROM payments p JOIN customer_invoices i ON i.id = p.invoice_id WHERE p.paid_at >= date_trunc('month', now()) GROUP BY i.currency")).rows;
      const m: Record<string, { outstandingMinor: number; overdueMinor: number; paidThisMonthMinor: number }> = {};
      for (const r of out) m[r.currency] = { outstandingMinor: r.outstanding, overdueMinor: r.overdue, paidThisMonthMinor: 0 };
      for (const r of paid) (m[r.currency] ??= { outstandingMinor: 0, overdueMinor: 0, paidThisMonthMinor: 0 }).paidThisMonthMinor = r.s;
      return { byCurrency: m };
    });
  });
}
