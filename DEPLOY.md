# Deploy Modulo for a demo: Neon (database) + Render (API) + Vercel (demo page)

Cost: $0. Fine for a demo with fake payments. NOT for real customers or real money (see "Before real customers").
You need free accounts on GitHub, Neon, Render. Vercel is optional (demo page only).

## 1. Put the code on GitHub
Make a new PRIVATE repo. Upload everything in this `server` folder as the repo root (`render.yaml`, `package.json`, `src/`, `db/`, `web/`).
`.env` and `node_modules` are already ignored. Never commit passwords.

## 2. Database on Neon
1. neon.tech > create project. Region: pick the closest to India that is offered (Singapore if available). Postgres 16 or newer.
2. Open "Connect". Copy TWO strings for the default role (usually `neondb_owner`):
   - **Direct** connection (host has no `-pooler`) = `MIGRATE_DATABASE_URL`
   - **Pooled** connection (host has `-pooler`) = the base for `DATABASE_URL` in step 3
3. Make up a password for the API's limited database user: 16+ random characters. This is `APP_DB_PASSWORD`. Save it.
4. Build `DATABASE_URL` from the pooled string: replace the user with `modulo_app` and the password with `APP_DB_PASSWORD`.
   Example: `postgres://modulo_app:YOURPASSWORD@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`

## 3. API on Render
1. render.com > New > Blueprint > pick the repo. It reads `render.yaml`.
2. Fill the 4 secrets it asks for: `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `APP_DB_PASSWORD`, `CORS_ORIGINS`.
   `CORS_ORIGINS` = the URL of your demo page (step 4). If unknown yet, put `https://example.com` and change it later.
3. Deploy. The start command runs `npm run migrate` first (creates tables, the `modulo_app` user, permissions), then starts the API.
4. Watch the logs. You want `migrate: ok` then the server listening.

### If you see: `migrate: canary failed ... needs BYPASSRLS`
The database owner role cannot read across tenants, so logins would silently fail. The migrator stops on purpose.
Do not work around it. Send me the exact message and which provider role you used; the fix is either a role that has BYPASSRLS
or a small change to the login functions.

## 3b. Check it works
On your computer, with Node 22+ installed in this folder: `npm install` then `npm run smoke -- https://YOUR-API.onrender.com`
Expect `smoke: all passed`. The first call can take about a minute while the free API wakes up. It creates two throwaway tenants named `smoke-*`.

## 4. Demo page on Vercel (optional)
1. Edit `web/index.html`: change `https://CHANGE-ME.onrender.com` to your API URL (no trailing slash). Commit.
2. vercel.com > Add New Project > same repo > **Root Directory: `web`** > Framework "Other" > Deploy.
3. Copy the Vercel URL into `CORS_ORIGINS` on Render and redeploy the API. Exact match: `https://name.vercel.app`, no trailing slash.
Vercel's free Hobby plan is non-commercial only. A demo that charges nobody is fine; move the page when you start selling.
Any static host works (Cloudflare Pages, Netlify, GitHub Pages). Add its URL to `CORS_ORIGINS`.

## What your partner should know (free tier)
- First visit after ~15 minutes idle takes about a minute (API sleeps). The database also sleeps and wakes. Open `/healthz` first to warm it.
- Payments are FAKE (`DEMO_MODE=true`). "Pay now" moves no money. Anyone with the link can sign up. Do not enter real customer data.
- Emails are only written to the log until you set `SMTP_URL`. Queued emails wait while the API sleeps.

## Razorpay later
1. Razorpay test keys, then set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` on Render.
2. Razorpay dashboard > Webhooks > `https://YOUR-API/webhooks/razorpay`, same secret, tick the `subscription.*` events.
3. Remove `DEMO_MODE`. With keys set the fake provider switches off by itself. Read the header of `src/razorpay.ts` first: it lists what to verify in test mode.

## Before real customers (not optional)
- Move API and database to always-on paid plans (free ones sleep, and Neon's free plan has hard monthly limits).
- Backups: set up a nightly `pg_dump` to storage you control, and test a restore once. Do not rely on free-plan backups.
- Own domain with HTTPS for the API, and a mail domain with SPF, DKIM, DMARC.
- Razorpay live mode (KYC), then a full test with a real small payment.
- Monitoring/alerts on `/healthz` and on failed webhooks (`webhook_events.error`) and failed emails (`email_outbox.status='failed'`).
- Terms of service, privacy policy, GST handling for your own invoices.
- Rotate `APP_DB_PASSWORD` by changing it in Render and redeploying (the migrator applies it).

## Unverified (I could not test these from here)
Render's current free-plan behaviour and region list, Neon's current free limits and regions, whether your Neon owner role has BYPASSRLS
(the migrator tells you), and Render's `NODE_VERSION` handling. Everything else (migrator, API, CORS, proxy rate limit, smoke test,
the demo page against the real API in Chromium) was run locally on Postgres 16.
