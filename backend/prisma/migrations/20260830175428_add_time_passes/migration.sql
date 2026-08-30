-- CreateEnum
CREATE TYPE "TimeSessionStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('DAY_PACK', 'TIME_PACK');

-- CreateEnum
CREATE TYPE "WalletUnit" AS ENUM ('DAY', 'MINUTE');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "durationMinutes" INTEGER,
ADD COLUMN     "kind" "ProductKind" NOT NULL DEFAULT 'DAY_PACK',
ALTER COLUMN "vpnDays" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "minuteBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "WalletTransaction" ADD COLUMN     "unit" "WalletUnit" NOT NULL DEFAULT 'DAY';

-- CreateTable
CREATE TABLE "TimeSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBilledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "status" "TimeSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "minutesBilled" INTEGER NOT NULL DEFAULT 0,
    "bytesUsed" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "TimeSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeSession_userId_status_idx" ON "TimeSession"("userId", "status");

-- AddForeignKey
ALTER TABLE "TimeSession" ADD CONSTRAINT "TimeSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
