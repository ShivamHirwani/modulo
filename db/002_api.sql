-- 002: auth tables + SECURITY DEFINER functions. App role may ONLY call these for pre-tenant work
-- (signup, login, session lookup). It cannot touch users/tenants/sessions tables directly.
-- PROD NOTE: the role that owns these functions needs BYPASSRLS (memberships is FORCE RLS).

ALTER TABLE users ADD COLUMN password_hash text;

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,                    -- sha256 of token; raw token never stored
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON sessions (expires_at);

CREATE TABLE enterprise_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, email text NOT NULL, company text, team_size text, message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION auth_signup(p_company text, p_slug text, p_currency char(3), p_name text, p_email citext, p_hash text)
RETURNS TABLE (out_tenant uuid, out_user uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t uuid; u uuid;
BEGIN
  INSERT INTO tenants (name, slug, currency, trial_ends_at) VALUES (p_company, p_slug, p_currency, now() + interval '14 days') RETURNING id INTO t;
  INSERT INTO users (email, name, password_hash) VALUES (p_email, p_name, p_hash) RETURNING id INTO u;
  INSERT INTO memberships (tenant_id, user_id, role) VALUES (t, u, 'owner');
  RETURN QUERY SELECT t, u;
END $$;

CREATE FUNCTION auth_login_lookup(p_email citext)
RETURNS TABLE (out_user uuid, out_hash text) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, password_hash FROM users WHERE email = p_email $$;

CREATE FUNCTION auth_user_memberships(p_user uuid)
RETURNS TABLE (out_tenant uuid, out_slug text, out_role text) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.tenant_id, t.slug, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user AND m.active ORDER BY t.created_at $$;

CREATE FUNCTION auth_session_create(p_hash bytea, p_user uuid, p_tenant uuid, p_ttl interval)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM sessions WHERE expires_at < now() - interval '1 day';
  INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at) VALUES (p_hash, p_user, p_tenant, now() + p_ttl);
END $$;

CREATE FUNCTION auth_session_get(p_hash bytea)
RETURNS TABLE (out_user uuid, out_tenant uuid, out_role text, out_status text, out_trial_ends timestamptz, out_enterprise boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.user_id, s.tenant_id, m.role, t.status, t.trial_ends_at, t.is_enterprise
  FROM sessions s
  JOIN memberships m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id AND m.active
  JOIN tenants t ON t.id = s.tenant_id
  WHERE s.token_hash = p_hash AND s.expires_at > now() $$;

CREATE FUNCTION auth_session_delete(p_hash bytea)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM sessions WHERE token_hash = p_hash $$;

CREATE FUNCTION auth_add_member(p_tenant uuid, p_name text, p_email citext, p_hash text, p_role text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u uuid;
BEGIN
  INSERT INTO users (email, name, password_hash) VALUES (p_email, p_name, p_hash) RETURNING id INTO u;
  INSERT INTO memberships (tenant_id, user_id, role) VALUES (p_tenant, u, p_role);
  RETURN u;
END $$;

-- functions default to EXECUTE for PUBLIC: remove it
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE proname LIKE 'auth\_%' AND pronamespace = 'public'::regnamespace LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC';
  END LOOP;
END $$;
