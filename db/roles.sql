-- App connects as modulo_app. NOT superuser, NOT table owner, NO bypassrls => RLS always applies.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='modulo_app') THEN
    CREATE ROLE modulo_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'change-me';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO modulo_app;
GRANT SELECT ON modules, module_prices TO modulo_app;   -- public catalog only
-- users + tenants are global tables with no tenant_id: expose ONLY tenant-scoped views, never the tables.
-- Views run as owner (may bypass RLS), so each view filters by app.tenant_id explicitly.
CREATE OR REPLACE VIEW tenant_users AS
  SELECT u.id, u.email, u.name, m.role, m.active
  FROM users u JOIN memberships m ON m.user_id = u.id
  WHERE m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;
CREATE OR REPLACE VIEW current_tenant AS
  SELECT id, name, slug, currency, is_enterprise, status, trial_ends_at
  FROM tenants WHERE id = nullif(current_setting('app.tenant_id', true), '')::uuid;
GRANT SELECT ON tenant_users, current_tenant TO modulo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  memberships, subscriptions, tenant_modules, subscription_events, platform_invoices, companies, contacts,
  departments, department_members, assets, asset_events, quotes, quote_items,
  customer_invoices, customer_invoice_items, payments, audit_log, number_counters, tenant_profile, email_outbox TO modulo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO modulo_app;

-- API entry points (see 002_api.sql) + public-facing insert-only table
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE (proname LIKE 'auth\_%' OR proname LIKE 'outbox\_%' OR proname LIKE 'billing\_%') AND pronamespace = 'public'::regnamespace LOOP
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO modulo_app';
  END LOOP;
END $$;
GRANT INSERT ON enterprise_leads TO modulo_app;

GRANT SELECT, INSERT, UPDATE ON webhook_events TO modulo_app;
GRANT SELECT, INSERT ON provider_plans TO modulo_app;
