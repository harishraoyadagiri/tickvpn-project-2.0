import { PrismaClient } from "@prisma/client";
import { env } from "../lib/env";
import { badRequest, HttpError, notFound } from "../lib/errors";
import { isValidWireGuardKey, nextFreeAddress, normaliseDeviceName } from "../lib/wireguard";
import { computeAllowedPeers } from "./authorizationService";

/**
 * There is no longer an adapter that pushes peers to nodes.
 *
 * The node agent is outbound-only: it pulls the authoritative peer set from
 * /api/internal/nodes/:id/peers every 15 seconds and makes wg0 match. That
 * removes the inbound HTTP port and the long-lived shared secret the old
 * RealNodeAdapter needed, and it removes a whole class of bug — a peer that
 * failed to install because a node was briefly unreachable now self-heals on
 * the next pass instead of staying broken.
 *
 * The trade-off is up to ~15 seconds between provisioning and the config
 * working, which D2 already accepted in the other direction ("known leakage:
 * up to ~15s ... documented, bounded, acceptable").
 */
const RECONCILE_WINDOW_SECONDS = 15;


/**
 * Least-loaded HEALTHY node in the region that still has capacity — and that
 * could actually carry traffic.
 *
 * That last clause is not pedantry. The seed registers one node per region with
 * `placeholder-<code>` as its public key, so the catalogue is complete before
 * any droplet exists. A device provisioned against one of those gets a
 * perfectly well-formed .conf naming a public key WireGuard will never
 * handshake with: the download works, the QR scans, the tunnel silently never
 * comes up, and nothing anywhere reports an error. During a staged rollout —
 * one real droplet, two placeholders — that is exactly the trap a tester falls
 * into by picking the wrong region from the menu.
 *
 * A node whose public key is not a real Curve25519 key cannot serve anyone, so
 * it is not a candidate. Picking a region that has no real node yet now fails
 * loudly with no_capacity, which is true and actionable.
 */
export async function selectHealthyNode(prisma: PrismaClient, regionCode: string) {
  const region = await prisma.region.findUnique({ where: { code: regionCode } });
  if (!region || !region.active) throw badRequest("region_unavailable", `Region ${regionCode} not available`);

  const candidates = await prisma.vPNNode.findMany({
    where: { regionId: region.id, status: "HEALTHY" },
    include: { _count: { select: { devices: { where: { status: "ACTIVE" } } } } },
  });

  const withRoom = candidates
    .filter((n) => isValidWireGuardKey(n.publicKey))
    .filter((n) => n._count.devices < n.capacity)
    .sort((a, b) => a._count.devices - b._count.devices);

  if (withRoom.length === 0) throw new HttpError(503, "no_capacity", `No node with capacity in ${regionCode}`);
  return withRoom[0];
}

/**
 * Provision (or re-provision) a device.
 *
 * Changes from the original: the caller's device cap is enforced here too (it
 * used to be checkable only on POST /devices, so this route was a bypass); a
 * public key that already belongs to somebody else is rejected instead of
 * silently reactivating their device; and the tunnel address is allocated from
 * this node's own subnet, reusing freed addresses, rather than from a global
 * count of every device that ever existed.
 */
export async function provisionDevice(
  prisma: PrismaClient,
  params: { userId: string; regionCode: string; devicePublicKey: unknown; deviceName: unknown }
) {
  const { userId, regionCode } = params;

  if (!isValidWireGuardKey(params.devicePublicKey)) {
    throw badRequest("invalid_public_key", "devicePublicKey must be a base64-encoded WireGuard public key");
  }
  const devicePublicKey = params.devicePublicKey;

  const deviceName = normaliseDeviceName(params.deviceName);
  if (!deviceName) throw badRequest("invalid_device_name", "deviceName must be 1-64 printable characters");

  const existing = await prisma.device.findUnique({ where: { publicKey: devicePublicKey } });
  if (existing && existing.userId !== userId) {
    // Never let one account touch another account's peer.
    throw badRequest("public_key_in_use", "That public key is already registered");
  }

  const node = await selectHealthyNode(prisma, regionCode);

  const device = await prisma.$transaction(async (tx) => {
    // selectHealthyNode's capacity check ran outside this transaction, so two
    // concurrent requests can both see the same node as "under capacity" and
    // both proceed. Serialize provisioning per node with an advisory lock
    // before re-checking, rather than trusting the earlier read.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${node.id})::bigint)`;

    if (!existing) {
      const active = await tx.device.count({ where: { userId, status: "ACTIVE" } });
      if (active >= env.MAX_DEVICES_PER_USER) {
        throw badRequest("device_limit_reached", `Maximum ${env.MAX_DEVICES_PER_USER} devices`);
      }
    }

    const isNewToThisNode = !existing || existing.nodeId !== node.id || existing.status !== "ACTIVE";
    if (isNewToThisNode) {
      const nodeLoad = await tx.device.count({ where: { nodeId: node.id, status: "ACTIVE" } });
      if (nodeLoad >= node.capacity) {
        throw new HttpError(503, "no_capacity", `No node with capacity in ${regionCode}`);
      }
    }

    const taken = await tx.device.findMany({
      where: { nodeId: node.id, internalIp: { not: null } },
      select: { internalIp: true },
    });
    const internalIp =
      existing?.nodeId === node.id && existing.internalIp
        ? existing.internalIp
        : nextFreeAddress(node.subnetBase, taken.map((d) => d.internalIp as string));

    return tx.device.upsert({
      where: { publicKey: devicePublicKey },
      update: { status: "ACTIVE", name: deviceName, nodeId: node.id, internalIp },
      create: { userId, publicKey: devicePublicKey, name: deviceName, status: "ACTIVE", nodeId: node.id, internalIp },
    });
  });

  return {
    device: {
      id: device.id,
      name: device.name,
      status: device.status,
      internalIp: device.internalIp,
      createdAt: device.createdAt,
    },
    region: regionCode,
    readyInSeconds: RECONCILE_WINDOW_SECONDS,
    config: {
      serverPublicKey: node.publicKey,
      serverEndpoint: `${node.publicIp}:${node.listenPort}`,
      internalIp: device.internalIp,
      dns: "1.1.1.1",
      allowedIps: "0.0.0.0/0, ::/0",
      // No PersistentKeepalive on purpose (D2): keepalive generates handshakes
      // with no user traffic, which would make handshake freshness useless as
      // a usage signal.
    },
  };
}

/**
 * Revoke a device. Scoped by userId — the old version looked the device up by
 * id alone, so any authenticated user could revoke anyone else's.
 */
export async function revokeDevice(prisma: PrismaClient, userId: string, deviceId: string) {
  const device = await prisma.device.findFirst({
    where: { id: deviceId, userId },
    include: { node: true },
  });
  if (!device) throw notFound("device_not_found");

  const updated = await prisma.device.update({
    where: { id: device.id },
    data: { status: "REVOKED", internalIp: null },
  });

  return { id: updated.id, name: updated.name, status: updated.status };
}

export { computeAllowedPeers };
