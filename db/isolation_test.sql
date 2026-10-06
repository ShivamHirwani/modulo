-- Run as superuser (setup) ; each test switches to modulo_app. Any FAIL aborts with non-zero exit.
\set ON_ERROR_STOP on
\set A '00000000-0000-0000-0000-00000000000a'
\set B '00000000-0000-0000-0000-00000000000b'

RESET ROLE;
TRUNCATE tenants CASCADE;
INSERT INTO tenants (id,name,slug) VALUES (:'A','Tenant A','a'),(:'B','Tenant B','b');
INSERT INTO companies (id,tenant_id,name) VALUES
  ('00000000-0000-0000-0000-0000000000a1',:'A','A-Co'),
  ('00000000-0000-0000-0000-0000000000b1',:'B','B-Co');

INSERT INTO users (id,email) VALUES ('00000000-0000-0000-0000-0000000000c1','a@x.com'),('00000000-0000-0000-0000-0000000000c2','b@x.com');
INSERT INTO memberships (tenant_id,user_id,role) VALUES (:'A','00000000-0000-0000-0000-0000000000c1','owner'),(:'B','00000000-0000-0000-0000-0000000000c2','owner');

SET ROLE modulo_app;

DO $$ DECLARE n int; BEGIN  -- T1
  PERFORM set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a',false);
  SELECT count(*) INTO n FROM companies;
  IF n<>1 THEN RAISE EXCEPTION 'FAIL T1 sees % rows', n; END IF; RAISE NOTICE 'PASS T1 tenant sees only own rows';
END $$;

DO $$ DECLARE n int; BEGIN  -- T2
  SELECT count(*) INTO n FROM companies WHERE id='00000000-0000-0000-0000-0000000000b1';
  IF n<>0 THEN RAISE EXCEPTION 'FAIL T2 read other tenant by id'; END IF; RAISE NOTICE 'PASS T2 cannot read other tenant row by id';
END $$;

DO $$ BEGIN  -- T3
  BEGIN
    INSERT INTO companies (tenant_id,name) VALUES ('00000000-0000-0000-0000-00000000000b','evil');
    RAISE EXCEPTION 'FAIL T3 inserted into other tenant';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS T3 cannot insert into other tenant'; END;
END $$;

DO $$ DECLARE n int; BEGIN  -- T4,T5
  UPDATE companies SET name='hacked' WHERE id='00000000-0000-0000-0000-0000000000b1'; GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'FAIL T4 updated other tenant'; END IF; RAISE NOTICE 'PASS T4 cannot update other tenant';
  DELETE FROM companies WHERE id='00000000-0000-0000-0000-0000000000b1'; GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'FAIL T5 deleted other tenant'; END IF; RAISE NOTICE 'PASS T5 cannot delete other tenant';
END $$;

DO $$ DECLARE n int; BEGIN  -- T6 no tenant set => nothing or error, never data
  PERFORM set_config('app.tenant_id','',false);
  BEGIN SELECT count(*) INTO n FROM companies; EXCEPTION WHEN OTHERS THEN n:=0; END;
  IF n<>0 THEN RAISE EXCEPTION 'FAIL T6 data visible with no tenant'; END IF; RAISE NOTICE 'PASS T6 no tenant = no data';
END $$;

DO $$ BEGIN  -- T7 cross-tenant foreign key
  PERFORM set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a',false);
  BEGIN
    INSERT INTO contacts (tenant_id,company_id,name) VALUES ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000b1','x');
    RAISE EXCEPTION 'FAIL T7 contact linked to other tenant company';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS T7 cross-tenant FK blocked'; END;
END $$;

DO $$ BEGIN  -- T7b assign asset to user of other tenant
  BEGIN
    INSERT INTO assets (tenant_id,tag,name,assigned_user_id) VALUES ('00000000-0000-0000-0000-00000000000a','T1','Laptop','00000000-0000-0000-0000-0000000000c2');
    RAISE EXCEPTION 'FAIL T7b asset assigned to other tenant user';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS T7b cross-tenant user link blocked'; END;
END $$;

DO $$ BEGIN  -- T7c same-tenant link still works
  INSERT INTO assets (tenant_id,tag,name,assigned_user_id) VALUES ('00000000-0000-0000-0000-00000000000a','T2','Laptop','00000000-0000-0000-0000-0000000000c1');
  INSERT INTO contacts (tenant_id,company_id,name) VALUES ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','ok');
  RAISE NOTICE 'PASS T7c same-tenant links allowed';
END $$;

DO $$ BEGIN  -- T8 role is safe
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'FAIL T8 app role bypasses RLS'; END IF;
  RAISE NOTICE 'PASS T8 app role cannot bypass RLS';
END $$;

DO $$ DECLARE n int; BEGIN  -- T10 global tables not readable; scoped views are
  PERFORM set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a',false);
  BEGIN PERFORM 1 FROM users; RAISE EXCEPTION 'FAIL T10 app read users table';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM tenants; RAISE EXCEPTION 'FAIL T10 app read tenants table';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  SELECT count(*) INTO n FROM tenant_users;
  IF n<>1 THEN RAISE EXCEPTION 'FAIL T10 tenant_users shows % rows', n; END IF;
  SELECT count(*) INTO n FROM current_tenant;
  IF n<>1 THEN RAISE EXCEPTION 'FAIL T10 current_tenant shows % rows', n; END IF;
  RAISE NOTICE 'PASS T10 users/tenants only via tenant-scoped views';
END $$;

DO $$ BEGIN  -- T11 sessions / leads unreadable by app role
  BEGIN PERFORM 1 FROM sessions; RAISE EXCEPTION 'FAIL T11 app read sessions';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM enterprise_leads; RAISE EXCEPTION 'FAIL T11 app read leads';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS T11 sessions and leads not readable by app role';
END $$;

RESET ROLE;
DO $$ DECLARE bad text; BEGIN  -- T9 guard: every tenant_id table has RLS on + forced
  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped
  WHERE c.relkind='r' AND c.relnamespace='public'::regnamespace AND c.relname<>'tenants'
    AND has_table_privilege('modulo_app', c.oid, 'SELECT')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL T9 no RLS on: %', bad; END IF;
  RAISE NOTICE 'PASS T9 every tenant table has forced RLS';
END $$;
