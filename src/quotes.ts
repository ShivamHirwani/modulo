// Module "quote": draft -> sent -> accepted/rejected -> converted (to invoice). Revise = new version.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "./db.ts";
import { HttpError, WRITE } from "./ctx.ts";
import type { Ctx } from "./ctx.ts";
import { Id, DateStr, CurrencyZ, ItemsSchema, replaceItems, nextNumber, audit, getQuote, getInvoice, QUOTE_SQL, fmtQuote } from "./documents.ts";

const QuoteBody = z.object({ companyId: Id, contactId: Id.optional(), currency: CurrencyZ.optional(), validUntil: DateStr.optional(), items: ItemsSchema.default([]) }).strict();
const QuoteUpdate = QuoteBody.partial().strict();
const ListQuery = z.object({ status: z.enum(["draft", "sent", "accepted", "rejected", "expired", "converted", "superseded"]).optional(), companyId: Id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) });
const ConvertBody = z.object({ dueDays: z.number().int().min(0).max(365).default(14) }).strict();

const idOf = (req: any) => Id.parse(req.params.id);
const lock = async (c: any, id: string) => {
  const r = (await c.query("SELECT *, (valid_until IS NOT NULL AND valid_until < current_date) AS past FROM quotes WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!r) throw new HttpError(404, "NOT_FOUND");
  return r;
};

export function registerQuotes(app: FastifyInstance, ctx: Ctx) {
  const guard = async (req: any, write: boolean) => {
    const a = await ctx.authenticate(req);
    if (write) ctx.needRole(a, WRITE);
    await ctx.needModule(a, "quote");
    return a;
  };

  app.post("/quotes", async (req, reply) => {
    const a = await guard(req, true);
    const b = QuoteBody.parse(req.body);
    const out = await withTenant(ctx.pool, a.tenantId, async (c) => {
      const cur = b.currency ?? (await c.query("SELECT currency FROM current_tenant")).rows[0].currency;
      const number = await nextNumber(c, a.tenantId, "quote", "QUO");
      const id = (await c.query("INSERT INTO quotes (tenant_id, number, company_id, contact_id, currency, valid_until) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [a.tenantId, number, b.companyId, b.contactId ?? null, cur, b.validUntil ?? null])).rows[0].id;
      await replaceItems(c, "quote", a.tenantId, id, b.items);
      await audit(c, a, "quote.create", "quote", id, { number });
      return getQuote(c, id);
    });
    return reply.code(201).send(out);
  });

  app.get("/quotes", async (req) => {
    const a = await guard(req, false);
    const q = ListQuery.parse(req.query);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      const rows = (await c.query(
        `SELECT * FROM (${QUOTE_SQL}) s WHERE ($1::text IS NULL OR eff_status = $1) AND ($2::uuid IS NULL OR company_id = $2) ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
        [q.status ?? null, q.companyId ?? null, q.limit, q.offset])).rows;
      return { items: rows.map((r) => fmtQuote(r)) };
    });
  });

  app.get("/quotes/:id", async (req) => {
    const a = await guard(req, false);
    return withTenant(ctx.pool, a.tenantId, (c) => getQuote(c, idOf(req)));
  });

  app.put("/quotes/:id", async (req) => {
    const a = await guard(req, true);
    const id = idOf(req), b = QuoteUpdate.parse(req.body);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      if ((await lock(c, id)).status !== "draft") throw new HttpError(409, "NOT_DRAFT", "only draft quotes can be edited; use revise");
      await c.query("UPDATE quotes SET company_id = COALESCE($2, company_id), contact_id = COALESCE($3, contact_id), currency = COALESCE($4, currency), valid_until = COALESCE($5, valid_until) WHERE id = $1", [id, b.companyId ?? null, b.contactId ?? null, b.currency ?? null, b.validUntil ?? null]);
      if (b.items) await replaceItems(c, "quote", a.tenantId, id, b.items);
      return getQuote(c, id);
    });
  });

  app.delete("/quotes/:id", async (req) => {
    const a = await guard(req, true);
    const id = idOf(req);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      if ((await lock(c, id)).status !== "draft") throw new HttpError(409, "NOT_DRAFT", "only draft quotes can be deleted");
      await c.query("DELETE FROM quotes WHERE id = $1", [id]);
      await audit(c, a, "quote.delete", "quote", id);
      return { ok: true };
    });
  });

  app.post("/quotes/:id/send", async (req) => {
    const a = await guard(req, true);
    const id = idOf(req);
    return withTenant(ctx.pool, a.tenantId, async (c) => {
      if ((await lock(c, id)).status !== "draft") throw new HttpError(409, "INVALID_STATE", "only draft quotes can be sent");
      const n = (await c.query("SELECT count(*)::int AS n FROM quote_items WHERE quote_id = $1", [id])).rows[0].n;
      if (n === 0) throw new HttpError(409, "EMPTY_DOCUMENT", "add at least one line before sending");
      await c.query("UPDATE quotes SET status = 'sent', valid_until = COALESCE(valid_until, current_date + 30) WHERE id = $1", [id]);
      await audit(c, a, "quote.send", "quote", id);
      return getQuote(c, id);
    });
  });

  for (const [action, to] of [["accept", "accepted"], ["reject", "rejected"]] as const) {
    app.post(`/quotes/:id/${action}`, async (req) => {
      const a = await guard(req, true);
      const id = idOf(req);
      return withTenant(ctx.pool, a.tenantId, async (c) => {
        const q = await lock(c, id);
        if (q.status !== "sent") throw new HttpError(409, "INVALID_STATE", `only sent quotes can be ${to}`);
        if (action === "accept" && q.past) throw new HttpError(409, "QUOTE_EXPIRED", "quote validity has passed; revise it");
        await c.query("UPDATE quotes SET status = $2 WHERE id = $1", [id, to]);
        await audit(c, a, `quote.${action}`, "quote", id);
        return getQuote(c, id);
      });
    });
  }

  app.post("/quotes/:id/revise", async (req, reply) => {
    const a = await guard(req, true);
    const id = idOf(req);
    const out = await withTenant(ctx.pool, a.tenantId, async (c) => {
      const q = await lock(c, id);
      if (!["sent", "rejected"].includes(q.status)) throw new HttpError(409, "INVALID_STATE", "only sent or rejected quotes can be revised");
      const v = (await c.query("SELECT max(version) + 1 AS v FROM quotes WHERE number = $1", [q.number])).rows[0].v;
      const nid = (await c.query("INSERT INTO quotes (tenant_id, number, version, company_id, contact_id, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [a.tenantId, q.number, v, q.company_id, q.contact_id, q.currency])).rows[0].id;
      await c.query("INSERT INTO quote_items (tenant_id, quote_id, position, description, qty, unit_minor, tax_bps, net_minor, tax_minor) SELECT tenant_id, $2, position, description, qty, unit_minor, tax_bps, net_minor, tax_minor FROM quote_items WHERE quote_id = $1", [id, nid]);
      await c.query("UPDATE quotes SET subtotal_minor = $2, tax_minor = $3, total_minor = $4 WHERE id = $1", [nid, q.subtotal_minor, q.tax_minor, q.total_minor]);
      await c.query("UPDATE quotes SET status = 'superseded' WHERE id = $1", [id]);
      await audit(c, a, "quote.revise", "quote", nid, { from: id, version: v });
      return getQuote(c, nid);
    });
    return reply.code(201).send(out);
  });

  // Quote -> invoice. Needs BOTH modules. One live invoice per quote (DB-enforced).
  app.post("/quotes/:id/convert", async (req, reply) => {
    const a = await ctx.authenticate(req);
    ctx.needRole(a, WRITE);
    await ctx.needModule(a, "quote");
    await ctx.needModule(a, "bill");
    const id = idOf(req), b = ConvertBody.parse(req.body ?? {});
    const out = await withTenant(ctx.pool, a.tenantId, async (c) => {
      const q = await lock(c, id);
      if (!["accepted", "converted"].includes(q.status)) throw new HttpError(409, "INVALID_STATE", "only accepted quotes can be converted");
      const live = (await c.query("SELECT id FROM customer_invoices WHERE quote_id = $1 AND status <> 'void'", [id])).rows[0];
      if (live) throw new HttpError(409, "ALREADY_INVOICED", `invoice ${live.id} already exists for this quote`);
      const iid = (await c.query("INSERT INTO customer_invoices (tenant_id, company_id, quote_id, currency, issue_date, due_date) VALUES ($1,$2,$3,$4, current_date, current_date + $5::int) RETURNING id", [a.tenantId, q.company_id, id, q.currency, b.dueDays])).rows[0].id;
      await c.query("INSERT INTO customer_invoice_items (tenant_id, invoice_id, position, description, qty, unit_minor, tax_bps, net_minor, tax_minor) SELECT tenant_id, $2, position, description, qty, unit_minor, tax_bps, net_minor, tax_minor FROM quote_items WHERE quote_id = $1", [id, iid]);
      await c.query("UPDATE customer_invoices SET subtotal_minor = $2, tax_minor = $3, total_minor = $4 WHERE id = $1", [iid, q.subtotal_minor, q.tax_minor, q.total_minor]);
      if (q.status === "accepted") await c.query("UPDATE quotes SET status = 'converted' WHERE id = $1", [id]);
      await audit(c, a, "quote.convert", "quote", id, { invoiceId: iid });
      return getInvoice(c, iid);
    });
    return reply.code(201).send(out);
  });
}
