# Modulo server

Node 22 + Fastify + Postgres 16. No build step in dev (Node strips types). `npm run typecheck` for types.

## Deploy
See `DEPLOY.md` (Neon + Render + Vercel, free demo). Local run below.

## Run
1. `createdb modulo`, then `MIGRATE_DATABASE_URL=postgres://owner@localhost/modulo APP_DB_PASSWORD=<16+ chars> npm run migrate`
2. Copy `.env.example` to `.env`, set `DATABASE_URL` with that password
3. `npm install && npm run dev`

## Test
- `bash db/run_tests.sh` builds `modulo_test` and runs 13 DB isolation checks (applies 001-005)
- `DATABASE_URL=postgres://modulo_app:...@127.0.0.1/modulo_test ADMIN_DATABASE_URL=postgres://postgres:...@127.0.0.1/modulo_test npm test`

## Endpoints
Public: `GET /catalog` `POST /pricing/quote` `POST /enterprise/inquiry` `POST /auth/signup` `POST /auth/login`
Auth (Bearer): `GET /me` `POST /auth/logout` `GET|PUT /subscription` `POST /team/members`
Core CRM: `GET|POST /companies` `GET|POST /contacts`
Module dept: `GET|POST /departments`. Module assets: `GET|POST /assets`
Module quote: `POST|GET /quotes`, `GET|PUT|DELETE /quotes/:id`, `POST /quotes/:id/{send,accept,reject,revise,convert}`
Module bill: `POST|GET /invoices`, `GET|PUT|DELETE /invoices/:id`, `POST /invoices/:id/{send,void,payments}`, `GET /billing/summary`
(`convert` needs both quote and bill. Send an `Idempotency-Key` header on payments.)
PDF: `GET /quotes/:id/pdf`, `GET /invoices/:id/pdf` (Bearer auth; fetch as blob, drafts get a DRAFT watermark)
Email: `POST /quotes/:id/email`, `POST /invoices/:id/email` body `{to?, cc?, message?}` -> 202 queued. `GET /emails`, `POST /emails/:id/retry`
Seller details printed on PDFs: `GET|PUT /settings/profile`

Billing: `POST /billing/checkout` (owner/admin), `POST /billing/verify`, `POST /billing/cancel` (owner), `POST /webhooks/:provider` (public, signed)
Dev only (fake provider): `POST /dev/billing/simulate {type: charged|pending|halted|cancelled, nextCycle?}`

## Payments (Razorpay later, works now without it)
Leave `RAZORPAY_*` empty and a fake provider runs: whole flow works, no money moves. With keys set, `RazorpayProvider` is used and the fake is off.
Production refuses to start without Razorpay keys. Lifecycle: trial (14d, all changes instant) -> checkout -> webhook `charged` = active ->
payment fails `pending` = past_due (access kept) -> `halted` = suspended (modules blocked) -> `charged` = active again; `cancelled` = blocked.
Webhooks are the only thing that grants access (idempotent, signature-checked on the raw body, stale events ignored).
Policy: once paid, plan changes (modules/seats) take effect at the NEXT renewal. A scheduled seat cut lowers the hiring cap immediately.
Not built: prorated mid-cycle upgrades (needs verifying Razorpay behaviour in test mode), monthly<->annual switch, GST on our own invoices, refunds.
Razorpay adapter is written from docs and tested against stubbed HTTP only. See the header of `src/razorpay.ts` for what to verify first.

## Email setup
Set `SMTP_URL` + `MAIL_FROM` (see `.env.example`). Without them mail is only logged. `MAIL_FROM` must be on a domain you own with SPF, DKIM and DMARC set,
or mail lands in spam. Customer's reply goes to the seller's profile email. Mail is queued in `email_outbox`; a worker retries
(1m, 5m, 30m, 2h, 6h) and marks failed after 5 tries. Limits: 20/day on trial, 200/day paid (tune in `outputs.ts`).

## Money rules (enforced in Postgres, not just API)
Sent quotes/invoices cannot change lines or totals. Status moves only along allowed paths. Payments are append-only.
Invoice numbers assigned at send, gapless per tenant. One live invoice per quote. Totals = subtotal + tax checked by constraint.

## Known gaps (on purpose, later steps)
- No payment yet: PUT /subscription grants modules during trial
- Team members added with a password by an admin; real product needs email invites + reset
- Password auth is hand-rolled (scrypt). Swap for WorkOS/Clerk/Auth0 before enterprise SSO
- Function owner role must have BYPASSRLS in production
- No customer-facing accept link, online payment link, company logo on PDFs, bounce/complaint handling, or email open tracking
- PDF built-in font is Latin only: other scripts print as `?`, INR prints as `INR 1,000.00`. Set PDF_FONT_REGULAR/BOLD to a TTF
  (Noto Sans for rupee sign; Noto Sans Gujarati / Devanagari for those scripts) to fix. Not yet tested with a Gujarati font.
- Email is at-least-once (rare duplicate if the server dies right after SMTP accepts). The PDF is rendered at delivery time, so it shows the invoice's state then (e.g. PAID)
- Tax is a flat rate per line (no GST CGST/SGST split, no tax-inclusive prices, no discounts)
- Dates use the DB server timezone (`current_date`); make it per-tenant before launch
