#!/usr/bin/env bash
# Fresh DB -> schema -> role -> isolation tests. Needs local Postgres 15+ and superuser access.
set -euo pipefail
cd "$(dirname "$0")"
psql -q -d postgres -c "DROP DATABASE IF EXISTS modulo_test" -c "CREATE DATABASE modulo_test"
psql -q -v ON_ERROR_STOP=1 -d modulo_test -f schema.sql
psql -q -v ON_ERROR_STOP=1 -d modulo_test -f 002_api.sql
psql -q -v ON_ERROR_STOP=1 -d modulo_test -f 003_money.sql
psql -q -v ON_ERROR_STOP=1 -d modulo_test -f 004_mail.sql
psql -q -v ON_ERROR_STOP=1 -d modulo_test -f 005_billing.sql
psql -q -v ON_ERROR_STOP=1 -d modulo_test -f roles.sql
psql -q -d modulo_test -f isolation_test.sql 2>&1 | grep -E "PASS|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
