// PDF endpoints + queued email, on real Postgres. Last test does a real SMTP round trip.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import type { ParsedMail } from "mailparser";
import { buildApp } from "./app.ts";
import { MemoryMailer, smtpMailer } from "./mail.ts";
import { textOf } from "./pdf.test.ts";

const URL = process.env.DATABASE_URL!, ADMIN = process.env.ADMIN_DATABASE_URL!;
if (!URL || !ADMIN) throw new Error("set DATABASE_URL and ADMIN_DATABASE_URL");
const mailer = new MemoryMailer();
const app = await buildApp({ databaseUrl: URL, rateLimitMax: 1000, mailer, mailFrom: "noreply@mail.modulo.test" });
const admin = new pg.Pool({ connectionString: ADMIN });
after(async () => { await app.close(); await admin.end(); });

const call = async (method: any, url: string, body?: unknown, token?: string, a = app) => {
  const r = await a.inject({ method, url, payload: body as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.headers["content-type"]?.toString().includes("json") ? (r.json() as any) : null, raw: r.rawPayload, headers: r.headers };
};
const uniq = () => Math.random().toString(36).slice(2, 10);
const signup = async (tag: string, a = app) => {
  const r = await call("POST", "/auth/signup", { companyName: `Co ${tag}`, name: tag, email: `${tag}-${uniq()}@test.dev`, password: "correct-horse-battery", currency: "INR" }, undefined, a);
  return { token: r.body.token as string, tenantId: r.body.tenant.id as string };
};
const ITEMS = [{ description: "Website build", qty: 1, unitMinor: 100000, taxBps: 1800 }, { description: "Hosting", qty: 12, unitMinor: 2500, taxBps: 0 }];
const due = (id: string) => admin.query("UPDATE email_outbox SET next_attempt_at = now() WHERE id = $1", [id]);
const row = async (id: string) => (await admin.query("SELECT status, attempts, last_error FROM email_outbox WHERE id = $1", [id])).rows[0];

await admin.query("DELETE FROM email_outbox"); // test DB only: start from an empty queue
const A = await signup("out-a"), B = await signup("out-b");
for (const t of [A, B]) assert.equal((await call("PUT", "/subscription", { moduleIds: ["quote", "bill"], seats: 5, billing: "monthly" }, t.token)).status, 200);
let company = "", contact = "", quoteId = "", invoiceId = "";

test("seller profile: member cannot edit; owner can", async () => {
  const p = await call("PUT", "/settings/profile", { legalName: "Bilimora Tech Works", address: "12 Station Road\nBilimora, Gujarat", taxId: "24ABCDE1234F1Z5", email: "billing@btw.test", paymentInstructions: "UPI: btw@bank" }, A.token);
  assert.equal(p.status, 200); assert.equal(p.body.legalName, "Bilimora Tech Works");
  assert.equal((await call("PUT", "/settings/profile", { phone: "123" }, A.token)).body.legalName, "Bilimora Tech Works"); // partial update keeps the rest
  const memberEmail = `mem-${uniq()}@test.dev`;
  await call("POST", "/team/members", { name: "Mem", email: memberEmail, password: "member-pass-1234", role: "member" }, A.token);
  const m = (await call("POST", "/auth/login", { email: memberEmail, password: "member-pass-1234" })).body.token;
  assert.equal((await call("PUT", "/settings/profile", { phone: "9" }, m)).status, 403);
  assert.equal((await call("GET", "/settings/profile", undefined, m)).status, 200);
});

test("PDF download: draft preview works, content correct, auth enforced", async () => {
  company = (await call("POST", "/companies", { name: "Acme Ltd", email: "accounts@acme.test", address: { line1: "Plot 4, GIDC", city: "Vapi", state: "Gujarat", postal: "396195" } }, A.token)).body.id;
  contact = (await call("POST", "/contacts", { name: "Mr Patel", email: "patel@acme.test", companyId: company }, A.token)).body.id;
  quoteId = (await call("POST", "/quotes", { companyId: company, contactId: contact, items: ITEMS }, A.token)).body.id;
  assert.equal((await call("GET", `/quotes/${quoteId}/pdf`)).status, 401);
  const r = await call("GET", `/quotes/${quoteId}/pdf`, undefined, A.token);
  assert.equal(r.status, 200); assert.equal(r.headers["content-type"], "application/pdf");
  assert.match(String(r.headers["content-disposition"]), /Quotation-QUO-0001\.pdf/);
  assert.equal(String(r.headers["cache-control"]), "private, no-store");
  const t = textOf(r.raw);
  for (const s of ["QUOTATION", "Bilimora Tech Works", "24ABCDE1234F1Z5", "Acme Ltd", "Plot 4, GIDC", "Vapi, Gujarat, 396195", "Attn: Mr Patel", "Website build", "INR 1,000.00"]) assert.ok(t.includes(s), `missing ${s}`);
});

test("cannot email a draft; recipient defaults to contact; queued then sent with PDF attached", async () => {
  assert.equal((await call("POST", `/quotes/${quoteId}/email`, {}, A.token)).body.error, "NOT_SENT");
  await call("POST", `/quotes/${quoteId}/send`, undefined, A.token);
  const r = await call("POST", `/quotes/${quoteId}/email`, {}, A.token);
  assert.equal(r.status, 202); assert.deepEqual(r.body.to, ["patel@acme.test"]); assert.equal(r.body.status, "queued");
  assert.equal(mailer.sent.length, 0); // nothing sent inside the request
  assert.equal(await app.flushMail(), 1);
  const m = mailer.sent[0];
  assert.deepEqual(m.to, ["patel@acme.test"]);
  assert.equal(m.subject, "Quotation QUO-0001 from Bilimora Tech Works");
  assert.equal(m.replyTo, "billing@btw.test"); assert.match(m.from, /^"Bilimora Tech Works via Modulo" <noreply@mail\.modulo\.test>$/);
  assert.equal(m.attachments[0].filename, "Quotation-QUO-0001.pdf"); assert.equal(m.attachments[0].contentType, "application/pdf");
  assert.ok(textOf(m.attachments[0].content).includes("QUO-0001"));
  assert.ok(m.text.includes("Hello Mr Patel") && m.text.includes("INR 1,480.00") && m.text.includes("Valid until"));
  assert.equal((await call("GET", `/emails?quoteId=${quoteId}`, undefined, A.token)).body.items[0].status, "sent");
});

test("double click within a minute does not send twice", async () => {
  const again = await call("POST", `/quotes/${quoteId}/email`, {}, A.token);
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true);
  assert.equal(await app.flushMail(), 0); assert.equal(mailer.sent.length, 1);
});

test("custom recipients + cc; message is HTML-escaped; header injection impossible", async () => {
  const r = await call("POST", `/quotes/${quoteId}/email`, { to: ["Boss@Acme.test"], cc: ["cfo@acme.test"], message: "Hi <script>alert(1)</script>\nBest" }, A.token);
  assert.equal(r.status, 202); assert.deepEqual(r.body.to, ["boss@acme.test"]);
  await app.flushMail();
  const m = mailer.sent[1];
  assert.deepEqual(m.cc, ["cfo@acme.test"]);
  assert.ok(m.html.includes("&lt;script&gt;") && !m.html.includes("<script>"));
  assert.equal((await call("POST", `/quotes/${quoteId}/email`, { to: ["a@b.co\r\nBcc: evil@x.co"] }, A.token)).status, 400);
  assert.equal((await call("POST", `/quotes/${quoteId}/email`, { to: ["a@b.co"], bcc: ["x@y.co"] }, A.token)).status, 400);
});

test("no recipient on file -> 422", async () => {
  const c2 = (await call("POST", "/companies", { name: "No Email Co" }, A.token)).body.id;
  const q2 = (await call("POST", "/quotes", { companyId: c2, items: ITEMS }, A.token)).body.id;
  await call("POST", `/quotes/${q2}/send`, undefined, A.token);
  assert.equal((await call("POST", `/quotes/${q2}/email`, {}, A.token)).body.error, "NO_RECIPIENT");
});

test("invoice: finance only; SMTP outage retries with backoff then succeeds", async () => {
  await call("POST", `/quotes/${quoteId}/accept`, undefined, A.token);
  invoiceId = (await call("POST", `/quotes/${quoteId}/convert`, {}, A.token)).body.id;
  assert.equal((await call("POST", `/invoices/${invoiceId}/email`, {}, A.token)).body.error, "NOT_SENT");
  await call("POST", `/invoices/${invoiceId}/send`, undefined, A.token);
  const pdf = await call("GET", `/invoices/${invoiceId}/pdf`, undefined, A.token);
  assert.ok(textOf(pdf.raw).includes("INV-0001") && textOf(pdf.raw).includes("Balance due"));
  mailer.failures = 1;
  const e = await call("POST", `/invoices/${invoiceId}/email`, { to: ["accounts@acme.test"] }, A.token);
  assert.equal(await app.flushMail(), 0);
  let r = await row(e.body.emailId);
  assert.equal(r.status, "queued"); assert.equal(r.attempts, 1); assert.match(r.last_error, /simulated SMTP outage/);
  assert.equal(await app.flushMail(), 0); // backoff: not due yet
  await due(e.body.emailId);
  assert.equal(await app.flushMail(), 1);
  r = await row(e.body.emailId);
  assert.equal(r.status, "sent"); assert.equal(r.attempts, 2); assert.equal(r.last_error, null);
  assert.equal(mailer.sent.at(-1)!.subject, "Invoice INV-0001 from Bilimora Tech Works");
});

test("gives up after 5 attempts; manual retry works", async () => {
  mailer.failures = 99;
  const e = (await call("POST", `/invoices/${invoiceId}/email`, { to: ["retry@acme.test"] }, A.token)).body.emailId;
  for (let i = 0; i < 5; i++) { await due(e); await app.flushMail(); }
  assert.equal((await row(e)).status, "failed"); assert.equal((await row(e)).attempts, 5);
  mailer.failures = 0;
  assert.equal((await call("POST", `/emails/${e}/retry`, undefined, A.token)).status, 200);
  assert.equal(await app.flushMail(), 1); assert.equal((await row(e)).status, "sent");
  assert.equal((await call("POST", `/emails/${e}/retry`, undefined, A.token)).status, 409); // only failed ones
});

test("document voided after queueing: permanent failure, nothing sent", async () => {
  const inv = (await call("POST", "/invoices", { companyId: company, items: ITEMS }, A.token)).body.id;
  await call("POST", `/invoices/${inv}/send`, undefined, A.token);
  const e = (await call("POST", `/invoices/${inv}/email`, {}, A.token)).body.emailId;
  await call("POST", `/invoices/${inv}/void`, undefined, A.token);
  const before = mailer.sent.length;
  await app.flushMail();
  assert.equal(mailer.sent.length, before);
  const r = await row(e); assert.equal(r.status, "failed"); assert.match(r.last_error, /void/);
  assert.equal((await call("POST", `/invoices/${inv}/email`, {}, A.token)).body.error, "NOT_SENT");
});

test("member can email quotes but not invoices", async () => {
  const email = `mem2-${uniq()}@test.dev`;
  await call("POST", "/team/members", { name: "Mem2", email, password: "member-pass-1234", role: "member" }, A.token);
  const m = (await call("POST", "/auth/login", { email, password: "member-pass-1234" })).body.token;
  assert.equal((await call("POST", `/invoices/${invoiceId}/email`, { to: ["x@y.co"] }, m)).body.error, "FORBIDDEN_ROLE");
  assert.equal((await call("POST", `/quotes/${quoteId}/email`, { to: ["member-sent@acme.test"] }, m)).status, 202);
});

test("other tenant cannot read PDFs or email our documents", async () => {
  assert.equal((await call("GET", `/quotes/${quoteId}/pdf`, undefined, B.token)).status, 404);
  assert.equal((await call("GET", `/invoices/${invoiceId}/pdf`, undefined, B.token)).status, 404);
  assert.equal((await call("POST", `/invoices/${invoiceId}/email`, { to: ["x@y.co"] }, B.token)).status, 404);
  assert.equal((await call("GET", "/emails", undefined, B.token)).body.items.length, 0);
});

test("background worker sends without anyone calling flush; real SMTP delivers a real PDF", async () => {
  const got: ParsedMail[] = [];
  const server = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], onData(stream, _s, cb) { simpleParser(stream).then((p) => { got.push(p); cb(); }, cb); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.server.address() as any).port;
  const live = await buildApp({ databaseUrl: URL, rateLimitMax: 1000, mailer: smtpMailer({ host: "127.0.0.1", port, secure: false, ignoreTLS: true }), mailFrom: "noreply@mail.modulo.test", mailWorkerMs: 100 });
  try {
    const T = await signup("smtp", live);
    await call("PUT", "/subscription", { moduleIds: ["bill"], seats: 2, billing: "monthly" }, T.token, live);
    await call("PUT", "/settings/profile", { legalName: "SMTP Seller", email: "reply@smtp-seller.test" }, T.token, live);
    const co = (await call("POST", "/companies", { name: "Cust", email: "cust@smtp.test" }, T.token, live)).body.id;
    const inv = (await call("POST", "/invoices", { companyId: co, items: ITEMS }, T.token, live)).body.id;
    await call("POST", `/invoices/${inv}/send`, undefined, T.token, live);
    assert.equal((await call("POST", `/invoices/${inv}/email`, {}, T.token, live)).status, 202);
    const find = () => got.find((g) => g.subject === "Invoice INV-0001 from SMTP Seller");
    for (let i = 0; i < 50 && !find(); i++) await new Promise((r) => setTimeout(r, 100));
    const p = find()!;
    assert.ok(p, "worker did not deliver"); // other tenants' queued mail may also flow through this worker; that is correct
    assert.equal(p.subject, "Invoice INV-0001 from SMTP Seller");
    assert.equal((p.to as any).value[0].address, "cust@smtp.test"); assert.equal((p.replyTo as any).value[0].address, "reply@smtp-seller.test");
    assert.equal(p.attachments.length, 1); assert.equal(p.attachments[0].contentType, "application/pdf");
    assert.equal(p.attachments[0].content.subarray(0, 5).toString(), "%PDF-");
    assert.ok(textOf(p.attachments[0].content).includes("INV-0001"));
    assert.ok(p.text!.includes("INR 1,480.00"));
  } finally { await live.close(); await new Promise<void>((r) => server.close(() => r())); }
});

test("daily email cap on trial accounts", async () => {
  await admin.query("INSERT INTO email_outbox (tenant_id, quote_id, to_emails, subject, status) SELECT $1, $2, ARRAY['x@y.co'], 's', 'sent' FROM generate_series(1, 20)", [A.tenantId, quoteId]);
  const r = await call("POST", `/quotes/${quoteId}/email`, { to: ["cap@acme.test"] }, A.token);
  assert.equal(r.status, 429); assert.equal(r.body.error, "EMAIL_LIMIT");
});
