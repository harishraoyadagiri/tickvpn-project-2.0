import { PrismaClient } from "@prisma/client";
import { applyWalletTransactionWithTx, InsufficientBalanceError } from "./walletService";

/**
 * Metered time passes (30 min / 1h / 3h / 6h / 12h).
 *
 * Unlike VPN Days (walletService + usageService: a flat 1-day charge that
 * opens a fixed 24h window, reconnects inside it free), a time pass drains
 * the wallet's minuteBalance minute-by-minute ONLY while actually connected.
 * Disconnecting pauses the meter; reconnecting resumes it. When the minute
 * balance hits zero mid-session, the session is force-ended.
 *
 * Billing happens via `tickTimeSession`, which bills whatever elapsed since
 * the last tick. Call it on every status poll while a session is ACTIVE (the
 * dashboard polls every few seconds) and once more on disconnect/end, so the
 * final partial minute gets billed too.
 */

export async function startTimeSession(prisma: PrismaClient, userId: string) {
  const existing = await prisma.timeSession.findFirst({
    where: { userId, status: "ACTIVE" },
  });
  if (existing) return { session: existing, alreadyActive: true };

  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet || wallet.minuteBalance <= 0) {
    throw new InsufficientBalanceError("MINUTE");
  }

  const now = new Date();
  const session = await prisma.timeSession.create({
    data: { userId, startsAt: now, lastBilledAt: now, status: "ACTIVE" },
  });
  return { session, alreadyActive: false };
}

export async function tickTimeSession(prisma: PrismaClient, userId: string) {
  const session = await prisma.timeSession.findFirst({
    where: { userId, status: "ACTIVE" },
  });
  if (!session) {
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    return { session: null, minutesBilledThisTick: 0, ranOut: false, minuteBalance: wallet?.minuteBalance ?? 0 };
  }

  const now = new Date();
  const elapsedMinutes = Math.floor((now.getTime() - session.lastBilledAt.getTime()) / 60000);
  if (elapsedMinutes <= 0) {
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    return { session, minutesBilledThisTick: 0, ranOut: false, minuteBalance: wallet?.minuteBalance ?? 0 };
  }

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    const available = wallet?.minuteBalance ?? 0;
    const toBill = Math.min(elapsedMinutes, available);
    const ranOut = toBill < elapsedMinutes; // wanted to bill more than the wallet has

    if (toBill > 0) {
      await applyWalletTransactionWithTx(tx, {
        userId,
        type: "USAGE",
        amount: -toBill,
        unit: "MINUTE",
        referenceType: "time_session",
        referenceId: session.id,
        // Keyed to the pre-tick lastBilledAt, so a retry of the exact same
        // tick (before this transaction commits its lastBilledAt bump) is a
        // no-op instead of double-billing.
        idempotencyKey: `time:${session.id}:${session.lastBilledAt.toISOString()}`,
      });
    }

    const updatedSession = await tx.timeSession.update({
      where: { id: session.id },
      data: {
        lastBilledAt: new Date(session.lastBilledAt.getTime() + toBill * 60000),
        minutesBilled: { increment: toBill },
        ...(ranOut ? { status: "ENDED", endedAt: now } : {}),
      },
    });

    const newWallet = await tx.wallet.findUnique({ where: { userId } });
    return {
      session: updatedSession,
      minutesBilledThisTick: toBill,
      ranOut,
      minuteBalance: newWallet?.minuteBalance ?? 0,
    };
  });
}

/** Bills any remaining elapsed time, then marks the session ENDED. */
export async function endTimeSession(prisma: PrismaClient, userId: string) {
  const result = await tickTimeSession(prisma, userId);
  if (!result.session || result.session.status === "ENDED") return result;

  const ended = await prisma.timeSession.update({
    where: { id: result.session.id },
    data: { status: "ENDED", endedAt: new Date() },
  });
  return { ...result, session: ended };
}

/** Read-only status — does NOT bill. Use tickTimeSession for that. */
export async function getTimeStatus(prisma: PrismaClient, userId: string) {
  const session = await prisma.timeSession.findFirst({
    where: { userId, status: "ACTIVE" },
  });
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  return { session, minuteBalance: wallet?.minuteBalance ?? 0 };
}
