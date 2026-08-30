-- Reconciles the two partial unique indexes that were applied by hand
-- (migrations_manual/001 and 002, via docker exec + psql) into Prisma's
-- own migration history, so `prisma migrate dev` stops detecting "drift"
-- between the tracked schema and the real database on every run.
--
-- This migration is marked as already-applied via `prisma migrate resolve`
-- (see reconcile-migration-drift.bat) rather than actually executed, since
-- both indexes already exist in the database. The IF NOT EXISTS guards make
-- it safe to re-run by hand too, if ever needed.

CREATE UNIQUE INDEX IF NOT EXISTS one_active_window_per_user
ON "UsageWindow" ("userId")
WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS one_active_time_session_per_user
ON "TimeSession" ("userId")
WHERE status = 'ACTIVE';
