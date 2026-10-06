-- 003: Quotes + Billing hardening. Money rules enforced IN THE DATABASE so no app bug can break them.
ALTER TABLE quotes ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE customer_invoices ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE quotes DROP CONSTRAINT quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check
  CHECK (status IN ('draft','sent','accepted','rejected','expired','converted','superseded'));
ALTER TABLE quotes ADD CONSTRAINT quotes_total_ok CHECK (total_minor = subtotal_minor + tax_minor);

-- invoice number is assigned when SENT (gapless, legal numbering); drafts have none
ALTER TABLE customer_invoices ALTER COLUMN number DROP NOT NULL;
ALTER TABLE customer_invoices ADD CONSTRAINT inv_number_when_sent CHECK (status = 'draft' OR number IS NOT NULL);
ALTER TABLE customer_invoices ADD CONSTRAINT inv_total_ok CHECK (total_minor = subtotal_minor + tax_minor);
-- one live invoice per quote (a voided one frees the quote to be converted again)
CREATE UNIQUE INDEX one_live_invoice_per_quote ON customer_invoices (tenant_id, quote_id) WHERE quote_id IS NOT NULL AND status <> 'void';

ALTER TABLE quote_items
  ADD COLUMN position int NOT NULL DEFAULT 0, ADD COLUMN net_minor bigint NOT NULL DEFAULT 0, ADD COLUMN tax_minor bigint NOT NULL DEFAULT 0,
  ADD CHECK (qty > 0), ADD CHECK (unit_minor >= 0), ADD CHECK (tax_bps BETWEEN 0 AND 10000);
ALTER TABLE customer_invoice_items
  ADD COLUMN position int NOT NULL DEFAULT 0, ADD COLUMN net_minor bigint NOT NULL DEFAULT 0, ADD COLUMN tax_minor bigint NOT NULL DEFAULT 0,
  ADD CHECK (qty > 0), ADD CHECK (unit_minor >= 0), ADD CHECK (tax_bps BETWEEN 0 AND 10000);

ALTER TABLE payments ADD COLUMN idempotency_key text, ADD COLUMN created_by uuid;
CREATE UNIQUE INDEX payments_idem ON payments (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE number_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL, next_val int NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, kind)
);
ALTER TABLE number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON number_counters
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------- guards (custom SQLSTATEs: MD001 locked, MD002 bad transition, MD003 append-only) ----------
CREATE FUNCTION quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND pg_trigger_depth() <= 1 THEN RAISE EXCEPTION 'only draft quotes can be deleted' USING ERRCODE = 'MD001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.number IS DISTINCT FROM OLD.number OR NEW.version <> OLD.version
     OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.currency <> OLD.currency OR NEW.subtotal_minor <> OLD.subtotal_minor OR NEW.tax_minor <> OLD.tax_minor
     OR NEW.total_minor <> OLD.total_minor OR NEW.valid_until IS DISTINCT FROM OLD.valid_until) THEN
    RAISE EXCEPTION 'quote is locked after sending' USING ERRCODE = 'MD001';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN
     (('draft','sent'),('sent','accepted'),('sent','rejected'),('sent','expired'),('sent','superseded'),
      ('rejected','superseded'),('expired','superseded'),('accepted','converted')) THEN
    RAISE EXCEPTION 'quote cannot go % -> %', OLD.status, NEW.status USING ERRCODE = 'MD002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_guard BEFORE UPDATE OR DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION quote_guard();

CREATE FUNCTION invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND pg_trigger_depth() <= 1 THEN RAISE EXCEPTION 'only draft invoices can be deleted' USING ERRCODE = 'MD001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.number IS DISTINCT FROM OLD.number OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.quote_id IS DISTINCT FROM OLD.quote_id OR NEW.currency <> OLD.currency
     OR NEW.issue_date <> OLD.issue_date OR NEW.due_date <> OLD.due_date
     OR NEW.subtotal_minor <> OLD.subtotal_minor OR NEW.tax_minor <> OLD.tax_minor OR NEW.total_minor <> OLD.total_minor) THEN
    RAISE EXCEPTION 'invoice is locked after sending' USING ERRCODE = 'MD001';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN
     (('draft','sent'),('sent','partial'),('sent','paid'),('sent','void'),('sent','overdue'),
      ('partial','paid'),('partial','overdue'),('overdue','partial'),('overdue','paid'),('overdue','void')) THEN
    RAISE EXCEPTION 'invoice cannot go % -> %', OLD.status, NEW.status USING ERRCODE = 'MD002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_guard BEFORE UPDATE OR DELETE ON customer_invoices FOR EACH ROW EXECUTE FUNCTION invoice_guard();

CREATE FUNCTION quote_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text; q uuid;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN q := OLD.quote_id; ELSE q := NEW.quote_id; END IF;
  SELECT status INTO s FROM quotes WHERE id = q;
  IF s IS NOT NULL AND s <> 'draft' THEN RAISE EXCEPTION 'quote lines are locked after sending' USING ERRCODE = 'MD001'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_items_guard BEFORE INSERT OR UPDATE OR DELETE ON quote_items FOR EACH ROW EXECUTE FUNCTION quote_items_guard();

CREATE FUNCTION invoice_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text; i uuid;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN i := OLD.invoice_id; ELSE i := NEW.invoice_id; END IF;
  SELECT status INTO s FROM customer_invoices WHERE id = i;
  IF s IS NOT NULL AND s <> 'draft' THEN RAISE EXCEPTION 'invoice lines are locked after sending' USING ERRCODE = 'MD001'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_items_guard BEFORE INSERT OR UPDATE OR DELETE ON customer_invoice_items FOR EACH ROW EXECUTE FUNCTION invoice_items_guard();

CREATE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'payments are append-only' USING ERRCODE = 'MD003';
END $$;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard();
