import { PrismaClient } from "@prisma/client";
import { TICK_PASS_TIERS } from "../src/services/pricingService";
const prisma = new PrismaClient();

async function main() {
  // Product.name isn't unique, so skipDuplicates can't prevent re-seeding
  // from piling up duplicate rows — wipe and reinsert instead. Safe in this
  // dev build: nothing here goes through real Stripe checkout (only the
  // /dev/credit-* bypass), so no Purchase rows reference these ids.
  await prisma.product.deleteMany({});
  await prisma.product.createMany({
    // VPN Days flat-window packs are retired — see tickvpn-pricing-model.md.
    // Every tier is now a metered Tick Pass, priced off one formula and
    // anchored to a single source of truth (pricingService.ts) instead of
    // being hardcoded here.
    data: TICK_PASS_TIERS.map((t) => ({
      name: t.name,
      kind: "TIME_PACK" as const,
      durationMinutes: t.minutes,
      priceCents: t.priceCents,
    })),
  });

  const regions = await prisma.region.createMany({
    data: [
      { code: "us", name: "United States", country: "US", city: "New York", sortOrder: 1 },
      { code: "eu", name: "Europe", country: "DE", city: "Frankfurt", sortOrder: 2 },
      { code: "asia", name: "Asia", country: "SG", city: "Singapore", sortOrder: 3 },
    ],
    skipDuplicates: true,
  });

  // Mock nodes so provisioning works end-to-end before real droplets exist.
  const us = await prisma.region.findUnique({ where: { code: "us" } });
  const eu = await prisma.region.findUnique({ where: { code: "eu" } });
  const asia = await prisma.region.findUnique({ where: { code: "asia" } });

  await prisma.vPNNode.createMany({
    data: [
      { regionId: us!.id, hostname: "us-node-1.mock", publicIp: "203.0.113.10", publicKey: "mockkey-us-1" },
      { regionId: eu!.id, hostname: "eu-node-1.mock", publicIp: "203.0.113.20", publicKey: "mockkey-eu-1" },
      { regionId: asia!.id, hostname: "asia-node-1.mock", publicIp: "203.0.113.30", publicKey: "mockkey-asia-1" },
    ],
    skipDuplicates: true,
  });

  console.log("Seed complete.");
}

main().finally(() => prisma.$disconnect());
