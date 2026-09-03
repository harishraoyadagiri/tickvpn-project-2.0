-- Creates the least-privilege role the application connects as.
--
-- Run once per database, as a superuser, BEFORE the first migration:
--
--   psql "$ADMIN_DATABASE_URL" -v app_password="'choose-a-real-password'" \
--        -f prisma/sql/app_role.sql
--
-- Then point DATABASE_URL at tickvpn_app rather than postgres.
--
-- Why this exists: Technical Decisions D3 says ledger immutability is a
-- database grant, not a convention. While the app connects as a superuser the
-- ledger is editable no matter what the code says, and an immutable ledger you
-- can technically edit is not immutable.

\set ON_ERROR_STOP on

-- psql does not substitute :variables inside dollar-quoted blocks, so the
-- role statement is built as text and executed with \gexec.
SELECT format('CREATE ROLE tickvpn_app LOGIN PASSWORD %L', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tickvpn_app')
\gexec

SELECT format('ALTER ROLE tickvpn_app LOGIN PASSWORD %L', :'app_password')
\gexec

GRANT CONNECT ON DATABASE :"DBNAME" TO tickvpn_app;
GRANT USAGE ON SCHEMA public TO tickvpn_app;

-- Existing objects.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tickvpn_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tickvpn_app;

-- Anything a future migration creates.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tickvpn_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tickvpn_app;

-- The ledger is append-only. This is the whole point of the role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'WalletTransaction') THEN
    REVOKE UPDATE, DELETE ON "WalletTransaction" FROM tickvpn_app;
  END IF;
END
$$;
