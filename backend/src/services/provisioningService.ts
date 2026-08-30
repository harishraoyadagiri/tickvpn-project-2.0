import { PrismaClient } from "@prisma/client";

/**
 * VPNNodeAdapter is the seam between the app and real infrastructure.
 * MockNodeAdapter lets the whole product work end-to-end today.
 * Swap in a RealNodeAdapter (SSH/API into your DO droplets, wg genkey,
 * `wg set` peer commands, nftables rules) without touching any route or
 * the wallet/usage engine at all.
 */
export interface VPNNodeAdapter {
  registerPeer(node: { hostname: string; publicIp: string }, devicePublicKey: string): Promise<{
    internalIp: string; // e.g. "10.66.0.4/32"
  }>;
  revokePeer(node: { hostname: string; publicIp: string }, devicePublicKey: string): Promise<void>;
  drainNode(node: { hostname: string }): Promise<void>;
}

export class MockNodeAdapter implements VPNNodeAdapter {
  private nextOctet = 2;

  async registerPeer(node: { hostname: string }, _devicePublicKey: string) {
    const ip = `10.66.0.${this.nextOctet++}/32`;
    console.log(`[mock] registered peer on ${node.hostname} -> ${ip}`);
    return { internalIp: ip };
  }

  async revokePeer(node: { hostname: string }, devicePublicKey: string) {
    console.log(`[mock] revoked ${devicePublicKey} from ${node.hostname}`);
  }

  async drainNode(node: { hostname: string }) {
    console.log(`[mock] draining ${node.hostname}`);
  }
}

// Swap this line for a RealNodeAdapter when your DO nodes are live.
const adapter: VPNNodeAdapter = new MockNodeAdapter();

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
  const { internalIp } = await adapter.registerPeer(node, devicePublicKey);

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
      // Real private key generation should happen client-side per PRD section 7.
      // This just returns everything the client needs to assemble the .conf/QR.
      dns: "1.1.1.1",
      allowedIps: "0.0.0.0/0, ::/0",
    },
  };
}

export async function revokeDevice(prisma: PrismaClient, deviceId: string) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw new Error("Device not found");

  // In a real adapter we'd look up which node this device is peered with.
  // MVP: revoke is authoritative in DB immediately; node sync is a fast-follow job.
  await prisma.device.update({ where: { id: deviceId }, data: { status: "REVOKED" } });
  return device;
}
