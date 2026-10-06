-- Modulo schema. PostgreSQL 15+. Money = integer minor units. Every tenant table has tenant_id + RLS.
-- App sets per request:  SET LOCAL app.tenant_id = '<uuid>';   (inside a transaction)
-- App DB role must NOT be superuser / table owner, or RLS is bypassed.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ========== PLATFORM (global, no RLS) ==========
CREATE TABLE modules (                         -- catalog
  id          text PRIMARY KEY,                -- 'quote','bill','assets','dept'
  name        text NOT NULL,
  launched    boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0
);
CREATE TABLE module_prices (                   -- versioned, never edit old rows
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id   text NOT NULL REFERENCES modules(id),
  currency    char(3) NOT NULL,
  monthly_minor int NOT NULL CHECK (monthly_minor >= 0),
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz
);
CREATE INDEX ON module_prices (module_id, currency, valid_from DESC);

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  currency    char(3) NOT NULL DEFAULT 'USD',
  is_enterprise boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','suspended','cancelled')),
  trial_ends_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext NOT NULL UNIQUE,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (                     -- user <-> tenant, role
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner','admin','manager','member','viewer')),
  active      boolean NOT NULL DEFAULT true,   -- active rows = billable seats
  PRIMARY KEY (tenant_id, user_id)
);

-- ========== SUBSCRIPTIONS ==========
CREATE TABLE subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  billing     text NOT NULL CHECK (billing IN ('monthly','annual')),
  seats       int  NOT NULL CHECK (seats >= 1),
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  provider    text,                            -- 'stripe' | 'razorpay'
  provider_sub_id text,
  quoted_period_minor bigint NOT NULL,         -- snapshot from pricing engine
  currency    char(3) NOT NULL
);
CREATE TABLE tenant_modules (                  -- ENTITLEMENTS: what this tenant may use
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_id   text NOT NULL REFERENCES modules(id),
  enabled_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  PRIMARY KEY (tenant_id, module_id)
);
CREATE TABLE subscription_events (             -- append-only audit of every change
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  type        text NOT NULL,                   -- module_added, seats_changed, payment_failed...
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_invoices (               -- what WE bill the tenant
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  lines       jsonb NOT NULL,                  -- pricing engine Quote.lines
  total_minor bigint NOT NULL,
  currency    char(3) NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void','failed')),
  provider_invoice_id text UNIQUE,             -- idempotency for webhooks
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ========== CORE CRM (tenant data) ==========
CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, email text, phone text, tax_id text, address jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  name text NOT NULL, email text, phone text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ========== MODULE: DEPARTMENTS ==========
CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  name text NOT NULL, head_user_id uuid REFERENCES users(id),
  budget_minor bigint, UNIQUE (tenant_id, name)
);
CREATE TABLE department_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (department_id, user_id)
);

-- ========== MODULE: ASSETS ==========
CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tag text NOT NULL, name text NOT NULL, category text, serial_no text,
  status text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','assigned','repair','retired')),
  purchase_date date, purchase_minor bigint, currency char(3),
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, tag)
);
CREATE TABLE asset_events (                    -- history: assigned, repaired, moved
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  type text NOT NULL, note text, by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);

-- ========== MODULE: QUOTES ==========
CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number text NOT NULL, version int NOT NULL DEFAULT 1,
  company_id uuid REFERENCES companies(id), contact_id uuid REFERENCES contacts(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','expired','converted')),
  currency char(3) NOT NULL, valid_until date,
  subtotal_minor bigint NOT NULL DEFAULT 0, tax_minor bigint NOT NULL DEFAULT 0, total_minor bigint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, number, version)
);
CREATE TABLE quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  description text NOT NULL, qty numeric(12,3) NOT NULL, unit_minor bigint NOT NULL, tax_bps int NOT NULL DEFAULT 0
);

-- ========== MODULE: BILLING (tenant's own customer invoices) ==========
CREATE TABLE customer_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number text NOT NULL, company_id uuid REFERENCES companies(id),
  quote_id uuid REFERENCES quotes(id),         -- set when converted from a quote
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','paid','overdue','void')),
  currency char(3) NOT NULL, issue_date date NOT NULL, due_date date NOT NULL,
  subtotal_minor bigint NOT NULL DEFAULT 0, tax_minor bigint NOT NULL DEFAULT 0, total_minor bigint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, number)
);
CREATE TABLE customer_invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  description text NOT NULL, qty numeric(12,3) NOT NULL, unit_minor bigint NOT NULL, tax_bps int NOT NULL DEFAULT 0
);
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0), method text, paid_at timestamptz NOT NULL DEFAULT now()
);

-- ========== AUDIT ==========
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid, action text NOT NULL, entity text, entity_id uuid, meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ========== CROSS-TENANT INTEGRITY ==========
-- FK checks run WITHOUT RLS, so plain FKs would let tenant A point at tenant B's rows.
-- Composite (tenant_id, id) FKs force parent and child into the same tenant.
ALTER TABLE companies          ADD UNIQUE (tenant_id, id);
ALTER TABLE contacts           ADD UNIQUE (tenant_id, id);
ALTER TABLE departments        ADD UNIQUE (tenant_id, id);
ALTER TABLE assets             ADD UNIQUE (tenant_id, id);
ALTER TABLE quotes             ADD UNIQUE (tenant_id, id);
ALTER TABLE customer_invoices  ADD UNIQUE (tenant_id, id);

ALTER TABLE contacts ADD FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id) ON DELETE SET NULL (company_id);
ALTER TABLE departments ADD FOREIGN KEY (tenant_id, parent_id) REFERENCES departments (tenant_id, id) ON DELETE SET NULL (parent_id);
ALTER TABLE departments ADD FOREIGN KEY (tenant_id, head_user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE SET NULL (head_user_id);
ALTER TABLE department_members ADD FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE department_members ADD FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE;
ALTER TABLE assets ADD FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id) ON DELETE SET NULL (department_id);
ALTER TABLE assets ADD FOREIGN KEY (tenant_id, assigned_user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE SET NULL (assigned_user_id);
ALTER TABLE asset_events ADD FOREIGN KEY (tenant_id, asset_id) REFERENCES assets (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE quotes ADD FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id);
ALTER TABLE quotes ADD FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id);
ALTER TABLE quote_items ADD FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE customer_invoices ADD FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id);
ALTER TABLE customer_invoices ADD FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id);
ALTER TABLE customer_invoice_items ADD FOREIGN KEY (tenant_id, invoice_id) REFERENCES customer_invoices (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE payments ADD FOREIGN KEY (tenant_id, invoice_id) REFERENCES customer_invoices (tenant_id, id) ON DELETE CASCADE;

-- ========== ROW LEVEL SECURITY ==========
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_modules','subscriptions','subscription_events','platform_invoices','companies','contacts',
    'departments','department_members','assets','asset_events','quotes','quote_items',
    'customer_invoices','customer_invoice_items','payments','audit_log','memberships'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  END LOOP;
END $$;

-- Seed the 4 launch modules
INSERT INTO modules (id, name, launched, sort_order) VALUES
 ('quote','Quotation System',true,1), ('bill','Billing & Invoicing',true,2),
 ('assets','Asset Management',true,3), ('dept','Department Management',true,4);
INSERT INTO module_prices (module_id, currency, monthly_minor) VALUES
 ('quote','USD',1200),('bill','USD',1800),('assets','USD',1500),('dept','USD',1200),
 ('quote','INR',105600),('bill','INR',158400),('assets','INR',132000),('dept','INR',105600),
 ('quote','EUR',1100),('bill','EUR',1650),('assets','EUR',1380),('dept','EUR',1100);
