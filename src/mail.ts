// Email: Mailer interface (SMTP / console / memory), message templates, and the outbox worker.
import nodemailer from "nodemailer";
import type { PoolClient } from "pg";
import { withTenant } from "./db.ts";
import type { Pool } from "./db.ts";
import { renderPdf, formatMoney } from "./pdf.ts";
import type { PdfOptions } from "./pdf.ts";
import { loadRenderData } from "./render-data.ts";

export interface MailMessage {
  from: string; replyTo?: string; to: string[]; cc?: string[]; subject: string; text: string; html: string;
  attachments: { filename: string; content: Buffer; contentType: string }[];
}
export interface Mailer { send(m: MailMessage): Promise<{ messageId: string }> }

export class MemoryMailer {
  sent: MailMessage[] = [];
  failures = 0; // next N sends throw (simulate outage)
  async send(m: MailMessage) {
    if (this.failures > 0) { this.failures--; throw new Error("simulated SMTP outage"); }
    this.sent.push(m);
    return { messageId: `mem-${this.sent.length}` };
  }
}
export class ConsoleMailer {
  async send(m: MailMessage) {
    console.log(`[mail:dev] to=${m.to.join(",")} subject="${m.subject}" attachments=${m.attachments.map((a) => `${a.filename}(${a.content.length}b)`).join(",")}`);
    return { messageId: "console" };
  }
}
export function smtpMailer(config: string | Record<string, unknown>): Mailer {
  const tp = nodemailer.createTransport(config as any);
  return { async send(m) { const r = await tp.sendMail(m); return { messageId: r.messageId }; } };
}

export class PermanentError extends Error {}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
const safeFile = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");

export function subjectFor(kind: "quote" | "invoice", number: string | null, version: number | undefined, seller: string) {
  const label = kind === "invoice" ? "Invoice" : "Quotation";
  return oneLine(`${label} ${number ?? ""}${kind === "quote" && (version ?? 1) > 1 ? ` (v${version})` : ""} from ${seller}`.replace("  ", " "));
}

export function buildBody(p: { kind: "quote" | "invoice"; number: string | null; sellerName: string; greetingName: string | null; total: string; balance: string; dueOrValid: string | null; message?: string | null }) {
  const label = p.kind === "invoice" ? "invoice" : "quotation";
  const hello = p.greetingName ? `Hello ${p.greetingName},` : "Hello,";
  const lines = [hello, "", `Please find attached ${label} ${p.number ?? ""} from ${p.sellerName}.`];
  if (p.message?.trim()) lines.push("", p.message.trim());
  lines.push("", `Total: ${p.total}`);
  if (p.kind === "invoice") lines.push(`Balance due: ${p.balance}`);
  if (p.dueOrValid) lines.push(`${p.kind === "invoice" ? "Due date" : "Valid until"}: ${p.dueOrValid}`);
  lines.push("", "The PDF is attached.", "", `Sent on behalf of ${p.sellerName}. Reply to this email to reach them.`);
  const text = lines.join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:560px">` +
    `<p>${esc(hello)}</p><p>Please find attached ${label} <b>${esc(p.number ?? "")}</b> from ${esc(p.sellerName)}.</p>` +
    (p.message?.trim() ? `<p style="white-space:pre-wrap">${esc(p.message.trim())}</p>` : "") +
    `<table style="border-collapse:collapse;margin:16px 0"><tr><td style="padding:4px 16px 4px 0;color:#666">Total</td><td><b>${esc(p.total)}</b></td></tr>` +
    (p.kind === "invoice" ? `<tr><td style="padding:4px 16px 4px 0;color:#666">Balance due</td><td><b>${esc(p.balance)}</b></td></tr>` : "") +
    (p.dueOrValid ? `<tr><td style="padding:4px 16px 4px 0;color:#666">${p.kind === "invoice" ? "Due date" : "Valid until"}</td><td>${esc(p.dueOrValid)}</td></tr>` : "") +
    `</table><p>The PDF is attached.</p><p style="color:#888;font-size:12px">Sent on behalf of ${esc(p.sellerName)}. Reply to this email to reach them.</p></div>`;
  return { text, html };
}

export const fromHeader = (displayName: string, address: string) => `"${displayName.replace(/["\r\n<>\\]/g, "").slice(0, 80)} via Modulo" <${address}>`;

export interface MailDeps { pool: Pool; mailer: Mailer; from: string; pdf: PdfOptions }

async function buildMessage(c: PoolClient, outboxId: string, d: MailDeps): Promise<MailMessage> {
  const o = (await c.query("SELECT * FROM email_outbox WHERE id = $1", [outboxId])).rows[0];
  if (!o) throw new PermanentError("outbox row not found");
  const kind = o.quote_id ? "quote" : "invoice";
  const docId = o.quote_id ?? o.invoice_id;
  const L = await loadRenderData(c, kind, docId);
  if (L.storedStatus === "void" || L.storedStatus === "draft" || L.storedStatus === "superseded") throw new PermanentError(`document is ${L.storedStatus}; not sent`);
  const pdf = await renderPdf(L.pdf, d.pdf);
  const unicode = Boolean(d.pdf.fontRegular && d.pdf.fontBold);
  const { text, html } = buildBody({
    kind, number: L.pdf.number, sellerName: L.sellerName, greetingName: L.contactName ?? L.customerName,
    total: formatMoney(L.totalMinor, L.pdf.currency, unicode), balance: formatMoney(L.balanceMinor, L.pdf.currency, unicode), dueOrValid: L.dueOrValid, message: o.message,
  });
  const file = safeFile(`${kind === "invoice" ? "Invoice" : "Quotation"}-${L.pdf.number ?? "DRAFT"}${kind === "quote" && (L.pdf.version ?? 1) > 1 ? `-v${L.pdf.version}` : ""}.pdf`);
  return {
    from: fromHeader(L.sellerName, d.from), replyTo: L.sellerEmail ?? undefined, to: o.to_emails, cc: o.cc_emails.length ? o.cc_emails : undefined,
    subject: o.subject, text, html, attachments: [{ filename: file, content: pdf, contentType: "application/pdf" }],
  };
}

const BACKOFF_MIN = [1, 5, 30, 120, 360];
const busy = new WeakSet<object>(); // one flush at a time per app instance

// Claim due rows, render + send each. At-least-once: a crash after SMTP accepts but before we record it can resend.
export async function processOutbox(d: MailDeps, limit = 10): Promise<number> {
  if (busy.has(d)) return 0;
  busy.add(d);
  try {
    const claimed = (await d.pool.query("SELECT * FROM outbox_claim($1)", [limit])).rows;
    let sent = 0;
    for (const r of claimed) {
      try {
        const msg = await withTenant(d.pool, r.out_tenant, (c) => buildMessage(c, r.out_id, d));
        const res = await d.mailer.send(msg);
        await d.pool.query("SELECT outbox_finish($1, true, NULL, $2, '0 minutes'::interval, false)", [r.out_id, res.messageId]);
        sent++;
      } catch (e: any) {
        const mins = BACKOFF_MIN[Math.min(r.out_attempts - 1, BACKOFF_MIN.length - 1)];
        await d.pool.query("SELECT outbox_finish($1, false, $2, NULL, ($3 || ' minutes')::interval, $4)", [r.out_id, String(e?.message ?? e), mins, e instanceof PermanentError]);
      }
    }
    return sent;
  } finally {
    busy.delete(d);
  }
}
