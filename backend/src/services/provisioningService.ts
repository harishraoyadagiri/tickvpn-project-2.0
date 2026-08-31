import { PrismaClient } from "@prisma/client";

/**
 * VPNNodeAdapter is the seam between the app and real infrastructure.
 * Toggle between them with USE_REAL_NODES in .env — no other code changes.
 */
export interface VPNNodeAdapter {
  registerPeer(
    node: { hostname: string; publicIp: string },
    devicePublicKey: string,
    internalIp: string
  ): Promise<void>;
  revokePeer(node: { hostname: string; publicIp: string }, devicePublicKey: string): Promise<void>;
  drainNode(node: { hostname: string }): Promise<void>;
}

export class MockNodeAdapter implements VPNNodeAdapter {
  async registerPeer(node: { hostname: string }, devicePublicKey: string, internalIp: string) {
    console.log(`[mock] registered ${devicePublicKey} on ${node.hostname} -> ${internalIp}`);
  }
  async revokePeer(node: { hostname: string }, devicePublicKey: string) {
    console.log(`[mock] revoked ${devicePublicKey} from ${node.hostname}`);
  }
  async drainNode(node: { hostname: string }) {
    console.log(`[mock] draining ${node.hostname}`);
  }
}

/**
 * Talks to the small agent (agent.py) running on each real WireGuard node.
 * Auth is a single shared secret (NODE_SHARED_SECRET) — fine for a handful
 * of trusted nodes; revisit before this is anything bigger.
 */
export class RealNodeAdapter implements VPNNodeAdapter {
  private secret = process.env.NODE_SHARED_SECRET || "";
  private port = 8787;

  async registerPeer(node: { publicIp: string }, devicePublicKey: string, internalIp: string) {
    const res = await fetch(`http://${node.publicIp}:${this.port}/peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Node-Secret": this.secret },
      body: JSON.stringify({ publicKey: devicePublicKey, allowedIp: internalIp }),
    });
    if (!res.ok) throw new Error(`Node agent rejected peer registration (${res.status})`);
  }

  async revokePeer(node: { publicIp: string }, devicePublicKey: string) {
    const res = await fetch(`http://${node.publicIp}:${this.port}/peers/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Node-Secret": this.secret },
      body: JSON.stringify({ publicKey: devicePublicKey }),
    });
    if (!res.ok) throw new Error(`Node agent rejected peer revocation (${res.status})`);
  }

  async drainNode(node: { hostname: string }) {
    console.log(`[real] drain not implemented yet for ${node.hostname} — remove peers manually via Console if needed`);
  }
}

const USE_REAL_NODES = process.env.USE_REAL_NODES === "true";
const adapter: VPNNodeAdapter = USE_REAL_NODES ? new RealNodeAdapter() : new MockNodeAdapter();

export async function selectHealthyNode(prisma: PrismaClient, regionCode: string) {
  const region = await prisma.region.findUnique({ where: { code: regionCode } });
  if (!region || !region.active) throw new Error(`Region ${regionCode} not available`);

  const candidates = await prisma.vPNNode.findMany({
    where: { regionId: region.id, status: "HEALTHY" },
    orderBy: { currentPeers: "asc" },
  });

  const node = candidates.find((n) => n.currentPeers < n.capacity);
  if (!node) throw new Error(`No healthy node with capacity in region ${regionCode}`);
  return node;
}

export async function provisionDevice(
  prisma: PrismaClient,
  params: { userId: string; regionCode: string; devicePublicKey: string; deviceName: string }
) {
  const { userId, regionCode, devicePublicKey, deviceName } = params;

  const node = await selectHealthyNode(prisma, regionCode);

  // IP allocation: offset by 10 so we never collide with .2–.9, which are
  // reserved for manually created test peers (like the one made by hand
  // during Sprint 1 validation). Global count is a known simplification —
  // fine with one real node; scope this per-node once there's more than one.
  const existingCount = await prisma.device.count({ where: { status: "ACTIVE" } });
  const internalIp = `10.8.0.${10 + existingCount}/32`;

  await adapter.registerPeer(node, devicePublicKey, internalIp);

  const device = await prisma.device.upsert({
    where: { publicKey: devicePublicKey },
    update: { status: "ACTIVE", name: deviceName },
    create: { userId, publicKey: devicePublicKey, name: deviceName, status: "ACTIVE" },
  });

  await prisma.vPNNode.update({
    where: { id: node.id },
    data: { currentPeers: { increment: 1 } },
  });

  return {
    device,
    config: {
      serverPublicKey: node.publicKey,
      serverEndpoint: `${node.publicIp}:51820`,
      internalIp,
      dns: "1.1.1.1",
      allowedIps: "0.0.0.0/0, ::/0",
    },
  };
}

export async function revokeDevice(prisma: PrismaClient, deviceId: string) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw new Error("Device not found");

  // NOTE: this only revokes in the database today — it does not yet call
  // the adapter to remove the peer from the real node (the schema doesn't
  // track which node a device is on yet). Fine for a small trusted group;
  // fix before this goes beyond that.
  await prisma.device.update({ where: { id: deviceId }, data: { status: "REVOKED" } });
  return device;
}
