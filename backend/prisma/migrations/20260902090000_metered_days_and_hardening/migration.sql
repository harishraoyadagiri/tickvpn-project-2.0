-- Metered day passes + the hardening the audit called for.
--
-- Model change: minutes are the only wallet currency. A "Day Pass" credits
-- 1440 minutes, drained only while a device is actually carrying traffic.
-- The flat 24h UsageWindow model is retired; its table is kept so historical
-- rows and their ledger references survive.

-- ─────────────────────────────────────────────────────────────
-- 1. The database guarantees from Technical Decisions D3
-- ─────────────────────────────────────────────────────────────

-- A wallet can never go negative. This should never fire; if it does, some
-- code path bypassed walletService and that is a Sev-1.
ALTER TABLE "Wallet"
  ADD CONSTRAINT "wallet_minute_balance_non_negative" CHECK ("minuteBalance" >= 0);
ALTER TABLE "Wallet"
  ADD CONSTRAINT "wallet_balance_non_negative" CHECK ("balance" >= 0);

-- Every ledger row must carry an idempotency key. Postgres allows unlimited
-- duplicate NULLs in a unique index, so a nullable key is not a constraint.
UPDATE "WalletTransaction"
   SET "idempotencyKey" = 'legacy:' || "id"
 WHERE "idempotencyKey" IS NULL;
ALTER TABLE "WalletTransaction" ALTER COLUMN "idempotencyKey" SET NOT NULL;

-- Minutes are the default unit now.
ALTER TABLE "WalletTransaction" ALTER COLUMN "unit" SET DEFAULT 'MINUTE';
ALTER TABLE "Product" ALTER COLUMN "kind" SET DEFAULT 'TIME_PACK';

-- ─────────────────────────────────────────────────────────────
-- 2. Stripe event log (D4 step 2)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "StripeEvent" (
    "id"          TEXT NOT NULL,
    "type"        TEXT NOT NULL,
    "receivedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────
-- 3. Postgres-backed rate limiting (D6)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "RateLimitHit" (
    "id"        TEXT NOT NULL,
    "bucket"    TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RateLimitHit_bucket_createdAt_idx" ON "RateLimitHit"("bucket", "createdAt");

-- ─────────────────────────────────────────────────────────────
-- 4. Nodes: per-node subnet and per-node bearer token
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "VPNNode"
  ADD COLUMN "subnetBase"     TEXT NOT NULL DEFAULT '10.8.0',
  ADD COLUMN "agentTokenHash" TEXT,
  ADD COLUMN "listenPort"     INTEGER NOT NULL DEFAULT 51820,
  ADD COLUMN "lastSeenAt"     TIMESTAMP(3);

CREATE INDEX "VPNNode_regionId_status_idx" ON "VPNNode"("regionId", "status");

-- currentPeers was incremented on every provision call, never decremented, and
-- inflated by re-provisioning the same device. Capacity is now derived from a
-- COUNT of ACTIVE devices on the node, so the column is dropped.
ALTER TABLE "VPNNode" DROP COLUMN IF EXISTS "currentPeers";

-- ─────────────────────────────────────────────────────────────
-- 5. Devices: which node, which address, and traffic telemetry
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "Device"
  ADD COLUMN "nodeId"          TEXT,
  ADD COLUMN "internalIp"      TEXT,
  ADD COLUMN "lastHandshakeAt" TIMESTAMP(3),
  ADD COLUMN "rxBytes"         BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "txBytes"         BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "cumulativeBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "qualifiedAt"     TIMESTAMP(3);

ALTER TABLE "Device"
  ADD CONSTRAINT "Device_nodeId_fkey"
  FOREIGN KEY ("nodeId") REFERENCES "VPNNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An address is unique within a node, not globally. Freed addresses are reused.
CREATE UNIQUE INDEX "Device_nodeId_internalIp_key" ON "Device"("nodeId", "internalIp");
CREATE INDEX "Device_userId_status_idx" ON "Device"("userId", "status");
CREATE INDEX "Device_status_idx" ON "Device"("status");

-- ─────────────────────────────────────────────────────────────
-- 6. Sessions: which device, last seen, why it ended
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "TimeSession"
  ADD COLUMN "deviceId"    TEXT,
  ADD COLUMN "lastSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "endedReason" TEXT;

CREATE INDEX "TimeSession_status_lastSeenAt_idx" ON "TimeSession"("status", "lastSeenAt");

ALTER TABLE "Product" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Backstops from the earlier manual migrations, restated so a fresh database
-- gets them without a second manual step.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_window_per_user
  ON "UsageWindow" ("userId") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_time_session_per_user
  ON "TimeSession" ("userId") WHERE status = 'ACTIVE';

-- ─────────────────────────────────────────────────────────────
-- 7. Ledger immutability is a grant, not a convention (D3)
-- ─────────────────────────────────────────────────────────────
-- The role itself is created by prisma/sql/app_role.sql, which needs
-- superuser and a password you supply. This block is a no-op until it exists,
-- so the migration is safe to run on a fresh database either way.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tickvpn_app') THEN
    REVOKE UPDATE, DELETE ON "WalletTransaction" FROM tickvpn_app;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON "User", "Wallet", "Product", "Purchase", "StripeEvent", "Region",
         "VPNNode", "Device", "UsageWindow", "TimeSession", "RateLimitHit"
      TO tickvpn_app;
    GRANT SELECT, INSERT ON "WalletTransaction" TO tickvpn_app;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────
-- 8. Server-side sessions and hashed magic-link tokens (D6)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "Session" (
    "tokenHash"  TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("tokenHash")
);
CREATE INDEX "Session_userId_idx"    ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LoginToken" (
    "tokenHash" TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginToken_pkey" PRIMARY KEY ("tokenHash")
);
CREATE INDEX "LoginToken_expiresAt_idx" ON "LoginToken"("expiresAt");
ALTER TABLE "LoginToken" ADD CONSTRAINT "LoginToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
