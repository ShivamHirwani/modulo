// Shared money math + helpers for quotes and invoices. All money = integer minor units. Rounding = half up.
import type { PoolClient } from "pg";
import { z } from "zod";
import { HttpError } from "./ctx.ts";
import type { Auth } from "./ctx.ts";

export const Id = z.string().uuid();
export const DateStr = z.string().refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), "use YYYY-MM-DD");
export const CurrencyZ = z.enum(["USD", "INR", "EUR"]);

export const ItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  qty: z.number().positive().max(100_000),
  unitMinor: z.number().int().min(0).max(100_000_000),
  taxBps: z.number().int().min(0).max(10_000).default(0), // 1800 = 18%
}).strict();
export const ItemsSchema = z.array(ItemSchema).max(200);
export type ItemIn = z.infer<typeof ItemSchema>;

export const qtyMilli = (q: number): number => {
  const m = Math.round(q * 1000);
  if (Math.abs(m / 1000 - q) > 1e-9) throw new HttpError(400, "VALIDATION", "qty allows at most 3 decimals");
  return m;
};

const half = (n: bigint, d: bigint) => (2n * n + d) / (2n * d); // round half up, n >= 0

export interface Totals { lines: { net: number; tax: number }[]; subtotal: number; tax: number; total: number }
export function computeTotals(items: ItemIn[]): Totals {
  const lines = items.map((i) => {
    const net = half(BigInt(qtyMilli(i.qty)) * BigInt(i.unitMinor), 1000n);
    const tax = half(net * BigInt(i.taxBps), 10_000n);
    return { net: Number(net), tax: Number(tax) };
  });
  const subtotal = lines.reduce((s, l) => s + l.net, 0);
  const tax = lines.reduce((s, l) => s + l.tax, 0);
  return { lines, subtotal, tax, total: subtotal + tax };
}

const T = {
  quote: { items: "quote_items", fk: "quote_id", head: "quotes" },
  invoice: { items: "customer_invoice_items", fk: "invoice_id", head: "customer_invoices" },
} as const;
export type DocKind = keyof typeof T;

// Replace all lines of a DRAFT document and refresh header totals (DB triggers refuse this on sent docs).
export async function replaceItems(c: PoolClient, kind: DocKind, tenantId: string, docId: string, items: ItemIn[]): Promise<Totals> {
  const t = T[kind];
  const tot = computeTotals(items);
  await c.query(`DELETE FROM ${t.items} WHERE ${t.fk} = $1`, [docId]);
  for (let i = 0; i < items.length; i++) {
    const it = items[i], l = tot.lines[i];
    await c.query(
      `INSERT INTO ${t.items} (tenant_id, ${t.fk}, position, description, qty, unit_minor, tax_bps, net_minor, tax_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, docId, i, it.description, (qtyMilli(it.qty) / 1000).toFixed(3), it.unitMinor, it.taxBps, l.net, l.tax],
    );
  }
  await c.query(`UPDATE ${t.head} SET subtotal_minor=$2, tax_minor=$3, total_minor=$4 WHERE id=$1`, [docId, tot.subtotal, tot.tax, tot.total]);
  return tot;
}

// Gapless per-tenant counter. Runs inside the caller's transaction: rollback = number not consumed.
export async function nextNumber(c: PoolClient, tenantId: string, kind: string, prefix: string): Promise<string> {
  const r = await c.query(
    `INSERT INTO number_counters (tenant_id, kind, next_val) VALUES ($1,$2,2)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET next_val = number_counters.next_val + 1 RETURNING next_val - 1 AS n`,
    [tenantId, kind],
  );
  return `${prefix}-${String(r.rows[0].n).padStart(4, "0")}`;
}

export async function audit(c: PoolClient, a: Auth, action: string, entity: string, id: string, meta: unknown = {}) {
  await c.query("INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, meta) VALUES ($1,$2,$3,$4,$5,$6)", [a.tenantId, a.userId, action, entity, id, JSON.stringify(meta)]);
}

const fmtItem = (r: any) => ({ id: r.id, position: r.position, description: r.description, qty: r.qty, unitMinor: r.unit_minor, taxBps: r.tax_bps, netMinor: r.net_minor, taxMinor: r.tax_minor });

export const QUOTE_SQL = `SELECT q.*, CASE WHEN q.status = 'sent' AND q.valid_until < current_date THEN 'expired' ELSE q.status END AS eff_status FROM quotes q`;
export const fmtQuote = (r: any, items?: any[]) => ({
  id: r.id, number: r.number, version: r.version, status: r.eff_status, companyId: r.company_id, contactId: r.contact_id, currency: r.currency,
  validUntil: r.valid_until, subtotalMinor: r.subtotal_minor, taxMinor: r.tax_minor, totalMinor: r.total_minor, createdAt: r.created_at,
  ...(items ? { items: items.map(fmtItem) } : {}),
});
export async function getQuote(c: PoolClient, id: string) {
  const r = (await c.query(`${QUOTE_SQL} WHERE q.id = $1`, [id])).rows[0];
  if (!r) throw new HttpError(404, "NOT_FOUND");
  const items = (await c.query("SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY position", [id])).rows;
  return fmtQuote(r, items);
}

export const INVOICE_SQL = `SELECT i.*,
  CASE WHEN i.status IN ('sent','partial') AND i.due_date < current_date THEN 'overdue' ELSE i.status END AS eff_status,
  COALESCE((SELECT sum(p.amount_minor) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_minor FROM customer_invoices i`;
export const fmtInvoice = (r: any, items?: any[], payments?: any[]) => ({
  id: r.id, number: r.number, status: r.eff_status, companyId: r.company_id, quoteId: r.quote_id, currency: r.currency,
  issueDate: r.issue_date, dueDate: r.due_date, subtotalMinor: r.subtotal_minor, taxMinor: r.tax_minor, totalMinor: r.total_minor,
  paidMinor: r.paid_minor, balanceMinor: r.total_minor - r.paid_minor, createdAt: r.created_at,
  ...(items ? { items: items.map(fmtItem) } : {}),
  ...(payments ? { payments: payments.map((p) => ({ id: p.id, amountMinor: p.amount_minor, method: p.method, paidAt: p.paid_at })) } : {}),
});
export async function getInvoice(c: PoolClient, id: string) {
  const r = (await c.query(`${INVOICE_SQL} WHERE i.id = $1`, [id])).rows[0];
  if (!r) throw new HttpError(404, "NOT_FOUND");
  const items = (await c.query("SELECT * FROM customer_invoice_items WHERE invoice_id = $1 ORDER BY position", [id])).rows;
  const pays = (await c.query("SELECT * FROM payments WHERE invoice_id = $1 ORDER BY paid_at, id", [id])).rows;
  return fmtInvoice(r, items, pays);
}
