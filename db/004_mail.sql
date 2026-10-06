-- 004: seller profile (printed on PDFs) + email outbox (reliable send with retry).

CREATE TABLE tenant_profile (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  legal_name text, address text, tax_id text, email text, phone text,
  payment_instructions text, footer_note text, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_profile
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quote_id uuid, invoice_id uuid,
  to_emails text[] NOT NULL, cc_emails text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL, message text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text, provider_message_id text, sent_at timestamptz,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((quote_id IS NOT NULL) <> (invoice_id IS NOT NULL)),           -- exactly one document
  CHECK (cardinality(to_emails) BETWEEN 1 AND 5 AND cardinality(cc_emails) <= 5),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES customer_invoices (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX email_outbox_due ON email_outbox (next_attempt_at) WHERE status IN ('queued','sending');
CREATE INDEX email_outbox_tenant ON email_outbox (tenant_id, created_at DESC);
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_outbox
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The worker has no tenant yet, so it claims work through definer functions (same BYPASSRLS note as auth_*).
-- Claim = mark 'sending' + push next_attempt 5 min out (if worker dies, row becomes due again). attempts counts tries.
CREATE FUNCTION outbox_claim(p_limit int)
RETURNS TABLE (out_id uuid, out_tenant uuid, out_attempts int) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE email_outbox SET status = 'failed', last_error = COALESCE(last_error, 'worker died after max attempts')
   WHERE status = 'sending' AND next_attempt_at <= now() AND attempts >= 5;
  RETURN QUERY
  UPDATE email_outbox o SET status = 'sending', attempts = o.attempts + 1, next_attempt_at = now() + interval '5 minutes'
   WHERE o.id IN (SELECT e.id FROM email_outbox e WHERE e.status IN ('queued','sending') AND e.next_attempt_at <= now()
                   ORDER BY e.next_attempt_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  RETURNING o.id, o.tenant_id, o.attempts;
END $$;

CREATE FUNCTION outbox_finish(p_id uuid, p_ok boolean, p_error text, p_msg_id text, p_retry_in interval, p_final boolean)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE email_outbox SET
    status = CASE WHEN p_ok THEN 'sent' WHEN p_final OR attempts >= 5 THEN 'failed' ELSE 'queued' END,
    sent_at = CASE WHEN p_ok THEN now() ELSE sent_at END,
    provider_message_id = COALESCE(p_msg_id, provider_message_id),
    last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    next_attempt_at = CASE WHEN p_ok OR p_final OR attempts >= 5 THEN next_attempt_at ELSE now() + p_retry_in END
  WHERE id = p_id $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE proname LIKE 'outbox\_%' AND pronamespace = 'public'::regnamespace LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC';
  END LOOP;
END $$;
