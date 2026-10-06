// Core CRM (always available, no module needed): companies + contacts.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "./db.ts";
import { WRITE } from "./ctx.ts";
import type { Ctx } from "./ctx.ts";
import { Id } from "./documents.ts";

const CompanyBody = z.object({ name: z.string().trim().min(1).max(160), email: z.string().email().max(254).optional(), phone: z.string().max(40).optional(), taxId: z.string().max(40).optional(), address: z.object({ line1: z.string().max(160).optional(), line2: z.string().max(160).optional(), city: z.string().max(80).optional(), state: z.string().max(80).optional(), postal: z.string().max(20).optional(), country: z.string().max(80).optional() }).strict().optional() }).strict();
const ContactBody = z.object({ name: z.string().trim().min(1).max(160), email: z.string().email().max(254).optional(), phone: z.string().max(40).optional(), companyId: Id.optional() }).strict();

export function registerCrm(app: FastifyInstance, ctx: Ctx) {
  app.get("/companies", async (req) => {
    const a = await ctx.authenticate(req);
    return withTenant(ctx.pool, a.tenantId, async (c) => ({ items: (await c.query("SELECT id, name, email, phone, tax_id, address FROM companies ORDER BY name LIMIT 500")).rows }));
  });
  app.post("/companies", async (req, reply) => {
    const a = await ctx.authenticate(req);
    ctx.needRole(a, WRITE);
    const b = CompanyBody.parse(req.body);
    const row = await withTenant(ctx.pool, a.tenantId, async (c) =>
      (await c.query("INSERT INTO companies (tenant_id, name, email, phone, tax_id, address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, phone, tax_id, address", [a.tenantId, b.name, b.email ?? null, b.phone ?? null, b.taxId ?? null, b.address ? JSON.stringify(b.address) : null])).rows[0]);
    return reply.code(201).send(row);
  });
  app.get("/contacts", async (req) => {
    const a = await ctx.authenticate(req);
    const q = z.object({ companyId: Id.optional() }).parse(req.query);
    return withTenant(ctx.pool, a.tenantId, async (c) => ({ items: (await c.query("SELECT id, name, email, phone, company_id FROM contacts WHERE ($1::uuid IS NULL OR company_id = $1) ORDER BY name LIMIT 500", [q.companyId ?? null])).rows }));
  });
  app.post("/contacts", async (req, reply) => {
    const a = await ctx.authenticate(req);
    ctx.needRole(a, WRITE);
    const b = ContactBody.parse(req.body);
    const row = await withTenant(ctx.pool, a.tenantId, async (c) =>
      (await c.query("INSERT INTO contacts (tenant_id, name, email, phone, company_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, phone, company_id", [a.tenantId, b.name, b.email ?? null, b.phone ?? null, b.companyId ?? null])).rows[0]);
    return reply.code(201).send(row);
  });
}
