// One-command database setup for any Postgres 15+ (Neon, Render, local). Safe to run on every deploy.
//   MIGRATE_DATABASE_URL = OWNER connection (direct, not pooled).  APP_DB_PASSWORD = password for the limited role the API uses.
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const fail = (m: string): never => { console.error("migrate: " + m); process.exit(1); };
const url = process.env.MIGRATE_DATABASE_URL ?? fail("MIGRATE_DATABASE_URL is required (owner connection)");
const appPw = process.env.APP_DB_PASSWORD ?? "";
if (appPw.length < 16 || appPw === "change-me") fail("APP_DB_PASSWORD must be set, 16+ characters, not the placeholder");

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db");
const files = ["schema.sql", ...readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort()];
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query("SELECT pg_advisory_lock(727274)"); // two deploys at once must not migrate together
  await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    console.log("migrate: applying " + f);
    try {
      await c.query("BEGIN");
      await c.query(readFileSync(join(dir, f), "utf8"));
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await c.query("COMMIT");
    } catch (e: any) { await c.query("ROLLBACK").catch(() => {}); fail(`${f} failed: ${e.message}`); }
  }

  // Limited app role + grants (idempotent: re-run so new tables get grants). Password comes from env, never from the repo.
  await c.query("BEGIN");
  await c.query(readFileSync(join(dir, "roles.sql"), "utf8").replace("PASSWORD 'change-me'", `PASSWORD ${lit(appPw)}`));
  await c.query(`ALTER ROLE modulo_app PASSWORD ${lit(appPw)}`);
  await c.query("COMMIT");

  // Canary: the login/session functions run as this owner and must be able to read across tenants (RLS bypass).
  // If they cannot, every login would silently fail in production. Rolled back, leaves no data.
  await c.query("BEGIN");
  try {
    const email = `canary-${Date.now()}@example.test`;
    await c.query("SELECT * FROM auth_signup('Canary','canary-' || substr(md5(random()::text),1,8),'USD','c',$1,'x')", [email]);
    const r = await c.query("SELECT * FROM auth_login_lookup($1)", [email]);
    if (r.rowCount !== 1) throw new Error("login lookup returned no row");
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => {});
    fail(`canary failed: ${e.message}. The owner role needs BYPASSRLS (or superuser). Fix: ALTER ROLE <owner> BYPASSRLS; or use a provider role that has it.`);
  }
  await c.query("ROLLBACK");
  console.log("migrate: ok");
} catch (e: any) {
  fail(e?.message ?? String(e));
} finally {
  await c.end();
}
