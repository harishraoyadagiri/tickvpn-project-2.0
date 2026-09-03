import { prisma, disconnect } from "../src/lib/prisma";
import { TICK_PASS_TIERS } from "../src/services/pricingService";

/**
 * Idempotent seed. The old version did deleteMany() on Product, which would
 * orphan Purchase rows the moment real checkouts existed.
 */
async function main() {
  for (const [i, tier] of TICK_PASS_TIERS.entries()) {
    const existing = await prisma.product.findFirst({ where: { durationMinutes: tier.minutes } });
    const data = {
      name: tier.name,
      kind: "TIME_PACK" as const,
      durationMinutes: tier.minutes,
      priceCents: tier.priceCents,
      sortOrder: i,
      active: true,
    };
    if (existing) await prisma.product.update({ where: { id: existing.id }, data });
    else await prisma.product.create({ data });
  }

  const regions = [
    { code: "us", name: "United States", country: "US", city: "New York", sortOrder: 1, subnetBase: "10.8.1" },
    { code: "eu", name: "Europe", country: "DE", city: "Frankfurt", sortOrder: 2, subnetBase: "10.8.2" },
    { code: "asia", name: "Asia", country: "SG", city: "Singapore", sortOrder: 3, subnetBase: "10.8.3" },
  ];

  for (const r of regions) {
    const region = await prisma.region.upsert({
      where: { code: r.code },
      update: { name: r.name, country: r.country, city: r.city, sortOrder: r.sortOrder, active: true },
      create: { code: r.code, name: r.name, country: r.country, city: r.city, sortOrder: r.sortOrder },
    });

    // One node per region. Public keys and IPs are placeholders until Terraform
    // creates real droplets; the local dev node below is the one that works.
    const hostname = `${r.code}-node-1`;
    const existing = await prisma.vPNNode.findFirst({ where: { hostname } });
    if (!existing) {
      await prisma.vPNNode.create({
        data: {
          regionId: region.id,
          hostname,
          publicIp: process.env[`NODE_IP_${r.code.toUpperCase()}`] ?? "127.0.0.1",
          publicKey: process.env[`NODE_PUBKEY_${r.code.toUpperCase()}`] ?? `placeholder-${r.code}`,
          subnetBase: r.subnetBase,
          status: "HEALTHY",
        },
      });
    }
  }

  const counts = {
    products: await prisma.product.count(),
    regions: await prisma.region.count(),
    nodes: await prisma.vPNNode.count(),
  };
  console.log("Seed complete:", counts);
  console.log(
    "\nA Day Pass is %d minutes. Mint a node agent token with:\n  POST /dev/nodes/<nodeId>/token",
    Number(process.env.MINUTES_PER_DAY_PASS ?? 1440)
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
