import { PrismaClient } from "@prisma/client";
import { applyWalletTransactionWithTx, InsufficientBalanceError } from "./walletService";

const WINDOW_HOURS = 24;
const BYTES_PER_DAY_ALLOWANCE = 10 * 1024 * 1024 * 1024; // 10 GB, configurable per PRD

/**
 * Call this on every qualifying VPN connection event (from your node's
 * connection webhook / heartbeat).
 *
 * Behavior:
 *  - If an ACTIVE window exists and hasn't expired -> no charge, return it.
 *  - If no active window (first connect, or previous one expired) -> debit
 *    one VPN Day and open a new 24h window.
 *  - If balance is zero -> throw InsufficientBalanceError; caller (route)
 *    should translate that into "buy more days" for the client.
 *
 * Concurrency: two devices connecting in the same millisecond both call
 * this. We rely on a unique partial index (one ACTIVE window per user) at
 * the DB level as the final backstop — see prisma migration note below —
 * plus the wallet's row lock, so at most one debit and one window can win.
 */
export async function startOrExtendUsageWindow(
  prisma: PrismaClient,
  userId: string
): Promise<{ window: any; charged: boolean }> {
  const now = new Date();

  const active = await prisma.usageWindow.findFirst({
    where: { userId, status: "ACTIVE" },
    orderBy: { startsAt: "desc" },
  });

  if (active && active.endsAt > now) {
    return { window: active, charged: false };
  }

  if (active && active.endsAt <= now) {
    await prisma.usageWindow.update({
      where: { id: active.id },
      data: { status: "EXPIRED" },
    });
  }

  const idempotencyKey = `usage:${userId}:${now.toISOString().slice(0, 13)}`; // hour-granular
  const endsAt = new Date(now.getTime() + WINDOW_HOURS * 60 * 60 * 1000);

  try {
    return await prisma.$transaction(async (tx) => {
      const { transaction } = await applyWalletTransactionWithTx(tx, {
        userId,
        type: "USAGE",
        amount: -1,
        referenceType: "usage_window",
        idempotencyKey,
      });

      const window = await tx.usageWindow.create({
        data: {
          userId,
          startsAt: now,
          endsAt,
          walletTransactionId: transaction.id,
          status: "ACTIVE",
        },
      });

      return { window, charged: true };
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      throw err;
    }
    throw err;
  }
}

/** Call on each bandwidth report from a node. Never store destinations, only totals. */
export async function recordBandwidth(prisma: PrismaClient, userId: string, bytesDelta: number) {
  const active = await prisma.usageWindow.findFirst({
    where: { userId, status: "ACTIVE" },
  });
  if (!active) return { allowanceExceeded: false, usedPct: 0 };

  const updated = await prisma.usageWindow.update({
    where: { id: active.id },
    data: { bytesUsed: { increment: bytesDelta } },
  });

  const usedPct = Number(updated.bytesUsed) / BYTES_PER_DAY_ALLOWANCE;
  return {
    allowanceExceeded: usedPct >= 1,
    warnThreshold: usedPct >= 0.8,
    usedPct,
  };
}

export async function getCurrentUsage(prisma: PrismaClient, userId: string) {
  return prisma.usageWindow.findFirst({
    where: { userId, status: "ACTIVE" },
    orderBy: { startsAt: "desc" },
  });
}
