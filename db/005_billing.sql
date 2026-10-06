-- 005: subscription billing (provider-agnostic: Razorpay, fake, later Stripe).
ALTER TABLE subscriptions
  ADD COLUMN provider_status text,                       -- created | active | pending | halted | cancelled
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN pending jsonb,                              -- change that starts at next renewal {moduleIds, seats, quotedPeriodMinor}
  ADD COLUMN last_provider_event_at timestamptz;         -- ignore older, out-of-order events
CREATE UNIQUE INDEX subscriptions_provider_sub ON subscriptions (provider, provider_sub_id) WHERE provider_sub_id IS NOT NULL;

-- Global platform tables (no tenant data to leak across tenants; tenant-facing code never reads them)
CREATE TABLE webhook_events (
  provider text NOT NULL, event_id text NOT NULL, type text NOT NULL, payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, error text,
  PRIMARY KEY (provider, event_id)                       -- idempotency: same event twice = processed once
);
CREATE TABLE provider_plans (                             -- provider plans are fixed-price, so one per (period, currency, amount)
  provider text NOT NULL, plan_key text NOT NULL, plan_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, plan_key)
);
ALTER TABLE platform_invoices ADD COLUMN paid_at timestamptz;

-- Webhooks arrive with no tenant: resolve it, and change tenant status, only through these two functions.
CREATE FUNCTION billing_find_tenant(p_provider text, p_sub text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tenant_id FROM subscriptions WHERE provider = p_provider AND provider_sub_id = p_sub $$;

CREATE FUNCTION billing_set_status(p_tenant uuid, p_status text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE tenants SET status = p_status WHERE id = p_tenant AND p_status IN ('active','past_due','suspended','cancelled') $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE proname LIKE 'billing\_%' AND pronamespace = 'public'::regnamespace LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC';
  END LOOP;
END $$;
