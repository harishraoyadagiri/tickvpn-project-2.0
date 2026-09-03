import { PrismaClient, Prisma } from "@prisma/client";
import { applyWalletTransactionWithTx } from "./walletService";
import { env } from "../lib/env";

/**
 * Metering. This is where a connection becomes money.
 *
 * The node agent reports every peer it can see, every 10 seconds:
 * public key, last handshake, and cumulative rx/tx counters. This service
 * turns that into minutes off a wallet.
 *
 * Three rules, all from Technical Decisions D2 and D5:
 *
 *  1. Usage only counts when the handshake is fresh (< 180 s) AND the peer has
 *     moved at least 5 MB since it was installed. A phone that wakes on a lock
 *     screen and completes one handshake must not cost the customer anything.
 *     "We charge you for using the VPN, not for having it installed."
 *
 *  2. Byte counters reset whenever a peer is removed and re-added or the node
 *     reboots, which the reconcile loop does routinely. A counter going
 *     backwards means a reset: count the new absolute value as the delta.
 *
 *  3. Time is never billed across a gap. If a peer went quiet and came back an
 *     hour later, the old session is closed at its last billed minute and a new
 *     one opens — the customer is not charged for the hour they were away.
 *
 * One ACTIVE session per user, enforced by a partial unique index. Two devices
 * connected at once is still one clock, so it costs one stream of minutes.
 */

const IDLE_END_SECONDS = 300; // no fresh report for 5 min closes the session

export interface PeerReport {
  publicKey: string;
  /** Unix seconds; 0 means "never". */
  latestHandshake: number;
  rxBytes: bigint;
  txBytes: bigint;
}

export interface ReportOutcome {
  deviceId: string;
  userId: string;
  qualifying: boolean;
  bytesDelta: bigint;
  minutesBilled: number;
  balanceAfter: number;
  sessionId: string | null;
  ranOut: boolean;
}

function isFresh(latestHandshake: number, now: Date): boolean {
  if (!latestHandshake) return false;
  const ageSeconds = now.getTime() / 1000 - latestHandshake;
  return ageSeconds >= 0 && ageSeconds <= env.HANDSHAKE_FRESH_SECONDS;
}

/**
 * Counter-reset-aware delta (D5). Report deltas, never absolutes.
 */
export function bytesDelta(previous: bigint, current: bigint): bigint {
  return current < previous ? current : current - previous;
}

/**
 * Process one node's report. Returns one outcome per peer we recognised.
 * Unknown public keys are ignored — the reconcile loop will remove them.
 */
export async function processNodeReport(
  prisma: PrismaClient,
  nodeId: string,
  peers: PeerReport[],
  now: Date = new Date()
): Promise<ReportOutcome[]> {
  const outcomes: ReportOutcome[] = [];

  await prisma.vPNNode.update({ where: { id: nodeId }, data: { lastSeenAt: now } });

  for (const peer of peers) {
    const device = await prisma.device.findFirst({
      where: { publicKey: peer.publicKey, nodeId },
      select: {
        id: true,
        userId: true,
        rxBytes: true,
        txBytes: true,
        cumulativeBytes: true,
        qualifiedAt: true,
      },
    });
    if (!device) continue;

    const delta = bytesDelta(device.rxBytes, peer.rxBytes) + bytesDelta(device.txBytes, peer.txBytes);
    const cumulative = device.cumulativeBytes + delta;
    const fresh = isFresh(peer.latestHandshake, now);
    const qualifying = fresh && cumulative >= BigInt(env.QUALIFYING_BYTES);

    await prisma.device.update({
      where: { id: device.id },
      data: {
        rxBytes: peer.rxBytes,
        txBytes: peer.txBytes,
        cumulativeBytes: cumulative,
        lastHandshakeAt: peer.latestHandshake ? new Date(peer.latestHandshake * 1000) : null,
        ...(fresh ? { lastConnectedAt: now } : {}),
        ...(qualifying && !device.qualifiedAt ? { qualifiedAt: now } : {}),
      },
    });

    const billing = qualifying
      ? await billUser(prisma, device.userId, device.id, delta, now)
      : await maybeCloseIdleSession(prisma, device.userId, now);

    outcomes.push({
      deviceId: device.id,
      userId: device.userId,
      qualifying,
      bytesDelta: delta,
      ...billing,
    });
  }

  return outcomes;
}

/**
 * Open or continue this user's metered session and bill the minutes that have
 * actually elapsed since the last billed minute.
 */
async function billUser(
  prisma: PrismaClient,
  userId: string,
  deviceId: string,
  bytesDeltaValue: bigint,
  now: Date
): Promise<{ minutesBilled: number; balanceAfter: number; sessionId: string | null; ranOut: boolean }> {
  return prisma.$transaction(async (tx) => {
    let session = await tx.timeSession.findFirst({ where: { userId, status: "ACTIVE" } });

    // Rule 3: never bill across a gap.
    if (session && now.getTime() - session.lastSeenAt.getTime() > IDLE_END_SECONDS * 1000) {
      await tx.timeSession.update({
        where: { id: session.id },
        data: { status: "ENDED", endedAt: session.lastSeenAt, endedReason: "idle" },
      });
      session = null;
    }

    if (!session) {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet || wallet.minuteBalance <= 0) {
        return { minutesBilled: 0, balanceAfter: wallet?.minuteBalance ?? 0, sessionId: null, ranOut: true };
      }
      session = await tx.timeSession.create({
        data: { userId, deviceId, startsAt: now, lastBilledAt: now, lastSeenAt: now, status: "ACTIVE" },
      });
      return { minutesBilled: 0, balanceAfter: wallet.minuteBalance, sessionId: session.id, ranOut: false };
    }

    const elapsedMinutes = Math.floor((now.getTime() - session.lastBilledAt.getTime()) / 60_000);

    if (elapsedMinutes <= 0) {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      await tx.timeSession.update({
        where: { id: session.id },
        data: { lastSeenAt: now, bytesUsed: { increment: bytesDeltaValue } },
      });
      return {
        minutesBilled: 0,
        balanceAfter: wallet?.minuteBalance ?? 0,
        sessionId: session.id,
        ranOut: false,
      };
    }

    // Keyed to the session and the running total, so a retry of the same tick
    // is a genuine no-op and two different ticks never collide.
    const { applied, balanceAfter } = await applyWalletTransactionWithTx(tx, {
      userId,
      type: "USAGE",
      amount: -elapsedMinutes,
      unit: "MINUTE",
      referenceType: "time_session",
      referenceId: session.id,
      idempotencyKey: `session:${session.id}:${session.minutesBilled}`,
      clampAtZero: true,
      metadata: { deviceId, requestedMinutes: elapsedMinutes },
    });

    const billed = Math.abs(applied);
    const ranOut = billed < elapsedMinutes || balanceAfter === 0;

    await tx.timeSession.update({
      where: { id: session.id },
      data: {
        // Advance only by what was billed, so an unbilled remainder is not lost.
        lastBilledAt: new Date(session.lastBilledAt.getTime() + billed * 60_000),
        lastSeenAt: now,
        minutesBilled: { increment: billed },
        bytesUsed: { increment: bytesDeltaValue },
        ...(ranOut ? { status: "ENDED" as const, endedAt: now, endedReason: "ran_out" } : {}),
      },
    });

    return { minutesBilled: billed, balanceAfter, sessionId: session.id, ranOut };
  });
}

/** A peer that is present but not carrying traffic closes its session after the grace period. */
async function maybeCloseIdleSession(
  prisma: PrismaClient,
  userId: string,
  now: Date
): Promise<{ minutesBilled: number; balanceAfter: number; sessionId: string | null; ranOut: boolean }> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  const session = await prisma.timeSession.findFirst({ where: { userId, status: "ACTIVE" } });

  if (session && now.getTime() - session.lastSeenAt.getTime() > IDLE_END_SECONDS * 1000) {
    await prisma.timeSession.update({
      where: { id: session.id },
      data: { status: "ENDED", endedAt: session.lastSeenAt, endedReason: "idle" },
    });
    return { minutesBilled: 0, balanceAfter: wallet?.minuteBalance ?? 0, sessionId: null, ranOut: false };
  }

  return {
    minutesBilled: 0,
    balanceAfter: wallet?.minuteBalance ?? 0,
    sessionId: session?.id ?? null,
    ranOut: false,
  };
}

/**
 * Close sessions whose node stopped reporting entirely (agent died, droplet
 * rebooted). Without this a session stays ACTIVE forever and blocks the next
 * one via the partial unique index. Runs on a timer from the scheduler.
 */
export async function closeAbandonedSessions(prisma: PrismaClient, now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - IDLE_END_SECONDS * 1000);
  const stale = await prisma.timeSession.findMany({
    where: { status: "ACTIVE", lastSeenAt: { lt: cutoff } },
    select: { id: true, lastSeenAt: true },
  });
  for (const s of stale) {
    await prisma.timeSession.update({
      where: { id: s.id },
      data: { status: "ENDED", endedAt: s.lastSeenAt, endedReason: "abandoned" },
    });
  }
  return stale.length;
}

/** Read-only view for the dashboard. Never bills — polling must not cost money. */
export async function getConnectionStatus(prisma: PrismaClient, userId: string) {
  const [wallet, session, devices] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId } }),
    prisma.timeSession.findFirst({ where: { userId, status: "ACTIVE" } }),
    prisma.device.findMany({
      where: { userId, status: "ACTIVE" },
      select: { id: true, name: true, lastHandshakeAt: true, nodeId: true, internalIp: true },
    }),
  ]);

  const minuteBalance = wallet?.minuteBalance ?? 0;
  return {
    minuteBalance,
    daysRemaining: +(minuteBalance / env.MINUTES_PER_DAY_PASS).toFixed(3),
    connected: session !== null,
    session: session
      ? {
          id: session.id,
          startedAt: session.startsAt,
          minutesBilled: session.minutesBilled,
          lastSeenAt: session.lastSeenAt,
          bytesUsed: session.bytesUsed,
        }
      : null,
    devices,
  };
}

export type MeteringPrisma = PrismaClient | Prisma.TransactionClient;
