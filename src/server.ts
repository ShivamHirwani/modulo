import { buildApp } from "./app.ts";
import { ConsoleMailer, smtpMailer } from "./mail.ts";
import { RazorpayProvider } from "./razorpay.ts";
import { FakeProvider } from "./provider.ts";
import { dbPlanStore } from "./billing.ts";

const env = process.env;
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (env.SMTP_URL && !env.MAIL_FROM) throw new Error("MAIL_FROM is required when SMTP_URL is set");

const rzp = { id: env.RAZORPAY_KEY_ID, secret: env.RAZORPAY_KEY_SECRET, hook: env.RAZORPAY_WEBHOOK_SECRET };
const useRazorpay = Boolean(rzp.id && rzp.secret && rzp.hook);
if ((rzp.id || rzp.secret || rzp.hook) && !useRazorpay) throw new Error("set all of RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET");
// The fake provider moves no money. In production it is only allowed on purpose, for a public demo (DEMO_MODE=true).
const demo = env.DEMO_MODE === "true";
if (!useRazorpay && env.NODE_ENV === "production" && !demo) throw new Error("production needs Razorpay keys, or DEMO_MODE=true for a demo with fake payments");
const reg = env.PDF_FONT_REGULAR, bold = env.PDF_FONT_BOLD;

const app = await buildApp({
  databaseUrl, logger: true, poolMax: Number(env.DB_POOL_MAX ?? 10),
  trustProxy: env.TRUST_PROXY === "true",
  corsOrigins: (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  mailer: env.SMTP_URL ? smtpMailer(env.SMTP_URL) : new ConsoleMailer(), // no SMTP_URL => emails are only logged, never sent
  mailFrom: env.MAIL_FROM, mailWorkerMs: 5000,
  billing: useRazorpay
    ? (pool) => new RazorpayProvider({ keyId: rzp.id!, keySecret: rzp.secret!, webhookSecret: rzp.hook!, plans: dbPlanStore(pool, "razorpay") })
    : () => new FakeProvider() as any,
  billingDevSimulate: !useRazorpay,
  pdf: reg && bold ? { fontRegular: reg, fontBold: bold } : {},
});
if (!useRazorpay) app.log.warn("FAKE PAYMENTS ACTIVE: no real money moves. Do not store real customer data.");
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { app.close().then(() => process.exit(0), () => process.exit(1)); });
await app.listen({ port: Number(env.PORT ?? 3000), host: "0.0.0.0" });
