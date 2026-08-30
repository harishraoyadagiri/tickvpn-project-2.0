-- Prisma's schema.prisma can't express partial unique indexes directly.
-- Run this once after your first `prisma migrate dev`, or drop it into a
-- migration.sql file inside prisma/migrations/ so it's tracked.
--
-- This is the final backstop against double-charging on concurrent connects:
-- even if two requests somehow both pass the application-level check, only
-- one INSERT can succeed here.

CREATE UNIQUE INDEX IF NOT EXISTS one_active_window_per_user
ON "UsageWindow" ("userId")
WHERE status = 'ACTIVE';
