// CORS allowlist, proxy-aware rate limiting, security headers. No DB writes needed beyond app start.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.ts";

const URL = process.env.DATABASE_URL!;
const app = await buildApp({ databaseUrl: URL, rateLimitMax: 1000, corsOrigins: ["https://demo.example.com"] });
const proxied = await buildApp({ databaseUrl: URL, rateLimitMax: 2, trustProxy: true });
const direct = await buildApp({ databaseUrl: URL, rateLimitMax: 2 });
after(async () => { await app.close(); await proxied.close(); await direct.close(); });

test("CORS: allowed origin gets headers on preflight and real calls; others get none", async () => {
  const pre = await app.inject({ method: "OPTIONS", url: "/quotes", headers: { origin: "https://demo.example.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
  assert.equal(pre.headers["access-control-allow-origin"], "https://demo.example.com");
  assert.match(String(pre.headers["access-control-allow-headers"]), /authorization/i);
  assert.equal(pre.headers["access-control-allow-credentials"], undefined);
  const real = await app.inject({ method: "GET", url: "/catalog", headers: { origin: "https://demo.example.com" } });
  assert.equal(real.headers["access-control-allow-origin"], "https://demo.example.com");
  const evil = await app.inject({ method: "GET", url: "/catalog", headers: { origin: "https://evil.example.com" } });
  assert.equal(evil.headers["access-control-allow-origin"], undefined);
  const evilPre = await app.inject({ method: "OPTIONS", url: "/quotes", headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" } });
  assert.equal(evilPre.headers["access-control-allow-origin"], undefined);
  assert.equal((await app.inject({ method: "GET", url: "/catalog" })).statusCode, 200); // non-browser callers (webhooks, curl) unaffected
});

test("security headers on every response", async () => {
  const r = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(r.headers["x-content-type-options"], "nosniff"); assert.equal(r.headers["cache-control"], "no-store");
  assert.match(String(r.headers["strict-transport-security"]), /max-age/);
  const e = await app.inject({ method: "GET", url: "/me" }); // error responses too
  assert.equal(e.statusCode, 401); assert.equal(e.headers["x-content-type-options"], "nosniff");
});

test("behind a proxy, rate limit is per real client IP; without trustProxy, X-Forwarded-For is ignored", async () => {
  const hit = (a: typeof app, ip: string) => a.inject({ method: "POST", url: "/auth/login", payload: { email: "a@b.co", password: "x" }, headers: { "x-forwarded-for": ip } });
  for (let i = 0; i < 2; i++) await hit(proxied, "1.1.1.1");
  assert.equal((await hit(proxied, "1.1.1.1")).statusCode, 429); // that client is limited
  assert.notEqual((await hit(proxied, "2.2.2.2")).statusCode, 429); // a different client is not
  for (let i = 0; i < 2; i++) await hit(direct, `9.9.9.${i}`);
  assert.equal((await hit(direct, "9.9.9.99")).statusCode, 429); // spoofing the header buys nothing when not behind a proxy
});

test("bearer tokens never reach the logs", async () => {
  const out: string[] = [];
  const logged = await buildApp({ databaseUrl: URL, logger: true, logStream: { write: (c: string) => { out.push(c); } } });
  await logged.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer mod_SECRET_TOKEN_VALUE", cookie: "sid=SECRET_COOKIE" } });
  await logged.close();
  const log = out.join("");
  assert.ok(log.includes('"url":"/me"'), "request was logged"); // proves we are really looking at the log
  assert.ok(!log.includes("SECRET_TOKEN_VALUE") && !log.includes("SECRET_COOKIE"));
});
