import { PrismaClient } from "@prisma/client";

/**
 * THE authorization query. There is exactly one, and this is it.
 *
 * Technical Decisions D2: "Authorization is expressed as peer set membership."
 * A device may carry traffic if and only if every clause below holds. When one
 * stops holding, the peer physically disappears from the node on the agent's
 * next reconcile pass — which is what makes a zero balance actually stop the
 * VPN rather than merely showing a number in a dashboard.
 *
 * Do not add a second query that decides this. If you need a new rule, add a
 * clause here.
 */
export interface AllowedPeer {
  publicKey: string;
  allowedIp: string;
}

export async function computeAllowedPeers(
  prisma: PrismaClient,
  nodeId: string
): Promise<AllowedPeer[]> {
  const rows = await prisma.device.findMany({
    where: {
      nodeId,
      status: "ACTIVE",
      internalIp: { not: null },
      user: {
        status: "ACTIVE",
        wallet: { minuteBalance: { gt: 0 } },
      },
    },
    select: { publicKey: true, internalIp: true },
  });

  return rows.map((d) => ({ publicKey: d.publicKey, allowedIp: d.internalIp as string }));
}

/**
 * Whether one specific device is currently authorised. Same clauses as above,
 * expressed for a single row so callers don't reimplement the rule.
 */
export async function isDeviceAuthorised(prisma: PrismaClient, deviceId: string): Promise<boolean> {
  const device = await prisma.device.findFirst({
    where: {
      id: deviceId,
      status: "ACTIVE",
      user: { status: "ACTIVE", wallet: { minuteBalance: { gt: 0 } } },
    },
    select: { id: true },
  });
  return device !== null;
}
