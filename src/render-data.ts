// Load everything a PDF/email needs, inside a tenant transaction.
import type { PoolClient } from "pg";
import { HttpError } from "./ctx.ts";
import { getQuote, getInvoice } from "./documents.ts";
import type { PdfData, PdfParty } from "./pdf.ts";

const addrLines = (a: any): string[] => {
  if (!a || typeof a !== "object") return [];
  return [a.line1, a.line2, [a.city, a.state, a.postal].filter(Boolean).join(", "), a.country].filter((x: any) => typeof x === "string" && x.trim());
};

export interface Loaded {
  pdf: PdfData; kind: "quote" | "invoice"; storedStatus: string;
  sellerName: string; sellerEmail: string | null;
  customerName: string; contactName: string | null; defaultTo: string | null;
  totalMinor: number; balanceMinor: number; dueOrValid: string | null;
}

export async function loadRenderData(c: PoolClient, kind: "quote" | "invoice", id: string): Promise<Loaded> {
  const doc: any = kind === "quote" ? await getQuote(c, id) : await getInvoice(c, id);
  const stored = (await c.query(`SELECT status, ${kind === "quote" ? "contact_id" : "NULL::uuid AS contact_id"} FROM ${kind === "quote" ? "quotes" : "customer_invoices"} WHERE id = $1`, [id])).rows[0];
  const company = doc.companyId ? (await c.query("SELECT * FROM companies WHERE id = $1", [doc.companyId])).rows[0] : null;
  const contact = stored.contact_id ? (await c.query("SELECT name, email FROM contacts WHERE id = $1", [stored.contact_id])).rows[0] : null;
  const prof = (await c.query("SELECT * FROM tenant_profile")).rows[0] ?? {};
  const tenant = (await c.query("SELECT name FROM current_tenant")).rows[0];
  const sellerName = prof.legal_name || tenant.name;
  const seller: PdfData["seller"] = {
    name: sellerName, lines: (prof.address ?? "").split("\n").map((s: string) => s.trim()).filter(Boolean),
    taxId: prof.tax_id, email: prof.email, phone: prof.phone, paymentInstructions: prof.payment_instructions, footerNote: prof.footer_note,
  };
  const customer: PdfParty = { name: company?.name ?? "(no customer)", lines: addrLines(company?.address), taxId: company?.tax_id };
  const items = doc.items.map((i: any) => ({ description: i.description, qty: i.qty, unitMinor: i.unitMinor, taxBps: i.taxBps, netMinor: i.netMinor, taxMinor: i.taxMinor }));
  const base = { kind, number: doc.number, status: doc.status, currency: doc.currency, seller, customer, attention: contact?.name ?? null, items, subtotalMinor: doc.subtotalMinor, taxMinor: doc.taxMinor, totalMinor: doc.totalMinor };
  const pdf: PdfData = kind === "quote"
    ? { ...base, version: doc.version, date: String(doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt).slice(0, 10), validUntil: doc.validUntil }
    : { ...base, date: doc.issueDate, dueDate: doc.dueDate, paidMinor: doc.paidMinor, balanceMinor: doc.balanceMinor };
  if (!doc.items) throw new HttpError(500, "INTERNAL");
  return {
    pdf, kind, storedStatus: stored.status, sellerName, sellerEmail: prof.email ?? null,
    customerName: customer.name, contactName: contact?.name ?? null, defaultTo: contact?.email || company?.email || null,
    totalMinor: doc.totalMinor, balanceMinor: kind === "invoice" ? doc.balanceMinor : doc.totalMinor, dueOrValid: kind === "quote" ? doc.validUntil : doc.dueDate,
  };
}
