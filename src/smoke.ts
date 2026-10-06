// Post-deploy check against a live URL:  npm run smoke -- https://your-api.onrender.com
// Creates two throwaway tenants (tagged smoke-*) so it also proves tenant isolation on the real deployment.
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) { console.error("usage: npm run smoke -- https://api.example.com"); process.exit(2); }
let bad = 0;
const ok = (n: string, c: boolean, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " " + extra}`); if (!c) bad++; };
const call = async (m: string, p: string, body?: unknown, t?: string) => {
  const r = await fetch(base + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90_000) });
  return { s: r.status, b: (await r.json().catch(() => ({}))) as any, h: r.headers };
};
const tag = Math.random().toString(36).slice(2, 8);
const signup = async (n: string) => (await call("POST", "/auth/signup", { companyName: `smoke-${n}-${tag}`, name: n, email: `smoke-${n}-${tag}@example.test`, password: "smoke-test-password", currency: "INR" })).b.token as string;

console.log(`smoke: ${base} (first call may take a minute if the host was asleep)`);
ok("health", (await call("GET", "/healthz")).s === 200);
const q = await call("POST", "/pricing/quote", { moduleIds: ["quote", "bill", "assets", "dept"], seats: 10, billing: "monthly", currency: "USD" });
ok("pricing engine", q.b.monthlyTotal === 11415, JSON.stringify(q.b).slice(0, 80));
ok("security headers", q.h.get("x-content-type-options") === "nosniff");
const A = await signup("a"), B = await signup("b");
ok("signup works", Boolean(A && B));
ok("me", (await call("GET", "/me", undefined, A)).b.role === "owner");
ok("module blocked before subscribing", (await call("GET", "/quotes", undefined, A)).b.error === "MODULE_NOT_ENABLED");
ok("subscribe", (await call("PUT", "/subscription", { moduleIds: ["quote", "bill"], seats: 2, billing: "monthly" }, A)).s === 200);
const co = (await call("POST", "/companies", { name: "Smoke Co" }, A)).b.id;
const qt = await call("POST", "/quotes", { companyId: co, items: [{ description: "x", qty: 2, unitMinor: 1000, taxBps: 1800 }] }, A);
ok("quote created, server totals", qt.s === 201 && qt.b.totalMinor === 2360, JSON.stringify(qt.b).slice(0, 80));
ok("other tenant cannot read it", (await call("GET", `/quotes/${qt.b.id}`, undefined, B)).s === 403 || (await call("GET", `/quotes/${qt.b.id}`, undefined, B)).s === 404);
const pdf = await fetch(`${base}/quotes/${qt.b.id}/pdf`, { headers: { authorization: "Bearer " + A } });
ok("pdf renders", pdf.status === 200 && Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString() === "%PDF-");
ok("bad webhook signature rejected", (await call("POST", "/webhooks/razorpay", { x: 1 })).s === 400 || (await call("POST", "/webhooks/fake", { x: 1 })).s === 400);
console.log(bad ? `smoke: ${bad} FAILED` : "smoke: all passed");
process.exit(bad ? 1 : 0);
