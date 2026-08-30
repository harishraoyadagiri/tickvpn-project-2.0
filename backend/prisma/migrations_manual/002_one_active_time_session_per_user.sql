-- Same reasoning as 001_one_active_window_per_user.sql, for the new metered
-- time-pack sessions: final DB-level backstop so two concurrent connects
-- can't both open an ACTIVE TimeSession for the same user.
--
-- Applied automatically by apply-time-passes-migration.bat. If you ever need
-- to run it by hand instead:
--   docker exec -i vpndays-db psql -U postgres -d vpndays < prisma/migrations_manual/002_one_active_time_session_per_user.sql

CREATE UNIQUE INDEX IF NOT EXISTS one_active_time_session_per_user
ON "TimeSession" ("userId")
WHERE status = 'ACTIVE';
