import crypto from "crypto";
import { prisma, disconnect } from "../src/lib/prisma";
import { isValidWireGuardKey } from "../src/lib/wireguard";
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

  const nodeReport: { hostname: string; region: string; note: string; status: string }[] = [];

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

    // One node per region, so the region menu is complete before the droplets
    // are. Set NODE_IP_<CODE> and NODE_PUBKEY_<CODE> to register a real one.
    //
    // A region without a real droplet gets an OFFLINE stand-in rather than a
    // HEALTHY one. That matters more than it looks: selectHealthyNode would
    // otherwise happily hand out a config naming a public key no machine holds,
    // and the result is a .conf that downloads, a QR that scans, and a tunnel
    // that silently never comes up. Failing with no_capacity is true and
    // actionable; issuing a config that cannot work is neither.
    //
    // Set SEED_LOCAL_NODES=true to mark the stand-ins HEALTHY anyway, which is
    // what local development and CI want — there the point is exercising the
    // flow, not carrying packets.
    const CODE = r.code.toUpperCase();
    const realIp = process.env[`NODE_IP_${CODE}`];
    const realKey = process.env[`NODE_PUBKEY_${CODE}`];
    const isReal = Boolean(realIp && realKey);

    const hostname = `${r.code}-node-1`;
    const existing = await prisma.vPNNode.findFirst({ where: { hostname } });

    // Base64 of 32 random bytes always ends in the character class a real
    // Curve25519 key does, so a stand-in is at least structurally valid.
    //
    // An existing key is kept — unless it could not possibly be a WireGuard key,
    // which is how rows seeded by earlier versions look (`placeholder-eu`).
    // Repair those rather than carrying them forward: provisioning filters out
    // nodes with unusable keys, so a preserved placeholder is a region that
    // silently never becomes selectable however many times you re-seed it.
    const standInKey =
      existing && isValidWireGuardKey(existing.publicKey)
        ? existing.publicKey
        : crypto.randomBytes(32).toString("base64");

    // A seed must never take a running node out of service. Re-running it after
    // a deploy, without the NODE_* variables to hand, would otherwise demote a
    // live droplet to OFFLINE and disconnect everyone on it. So this promotes,
    // and never demotes: taking a node down is a deliberate act, not a side
    // effect of re-seeding.
    const promote = isReal || process.env.SEED_LOCAL_NODES === "true";
    const status = promote ? ("HEALTHY" as const) : (existing?.status ?? ("OFFLINE" as const));

    const nodeData = {
      regionId: region.id,
      hostname,
      publicIp: realIp ?? existing?.publicIp ?? "127.0.0.1",
      publicKey: realKey ?? standInKey,
      subnetBase: r.subnetBase,
      status,
    };

    // Update rather than skip. The whole point of re-running the seed once a
    // droplet exists is to promote that region's stand-in to the real thing —
    // the old version saw the hostname already present and did nothing at all.
    if (existing) await prisma.vPNNode.update({ where: { id: existing.id }, data: nodeData });
    else await prisma.vPNNode.create({ data: nodeData });

    const note = isReal
      ? `registered from NODE_IP_${CODE} / NODE_PUBKEY_${CODE}`
      : existing
        ? "existing registration, left as it was"
        : "stand-in — no droplet registered";
    nodeReport.push({ hostname, region: r.name, note, status });
  }

  const counts = {
    products: await prisma.product.count(),
    regions: await prisma.region.count(),
    nodes: await prisma.vPNNode.count(),
  };
  console.log("Seed complete:", counts);

  console.log("\nNodes:");
  for (const n of nodeReport) {
    const usable = n.status === "HEALTHY" ? "selectable" : "NOT selectable";
    console.log(`  ${n.hostname.padEnd(14)} ${n.region.padEnd(15)} ${n.status.padEnd(8)} ${usable.padEnd(14)} ${n.note}`);
  }

  const usableCount = nodeReport.filter((n) => n.status === "HEALTHY").length;
  if (usableCount === 0) {
    console.log(
      "\nNo region can be provisioned yet. Register a droplet with:\n" +
        "  NODE_IP_US=203.0.113.10 NODE_PUBKEY_US=<wg show wg0 public-key> npm run seed\n" +
        "or, for local work where no droplet exists:\n" +
        "  SEED_LOCAL_NODES=true npm run seed"
    );
  }

  console.log(
    "\nA Day Pass is %d minutes. Mint a node agent token with:\n  npm run node:token -- <hostname>",
    Number(process.env.MINUTES_PER_DAY_PASS ?? 1440)
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
