/**
 * Mint a bearer token for a VPN node.
 *
 *   npm run node:token -- --list
 *   npm run node:token -- <nodeId|hostname>
 *
 * Why this exists as a script rather than a route.
 *
 * The only other way to mint one is POST /dev/nodes/:id/token, which lives in
 * devRouter. That router returns empty unless ENABLE_DEV_ROUTES=true, and
 * assertConfigValid() refuses to start when that flag is set alongside
 * NODE_ENV=production. Both of those are correct — an endpoint that mints a
 * credential capable of controlling a node's peer set has no business being
 * reachable on the public internet. The consequence was that a *deployed* API
 * had no way at all to authorise its own node.
 *
 * A script closes that gap without reopening the hole: it needs shell access to
 * something holding DATABASE_URL, which is a far higher bar than "can reach
 * port 443", and it leaves no attack surface behind when it exits.
 *
 * The token is shown exactly once. Only its SHA-256 is stored, so a lost token
 * is re-minted rather than recovered — and re-minting immediately invalidates
 * the previous one, which is the intended way to rotate a compromised node.
 */
import { prisma, disconnect } from "../src/lib/prisma";
import { generateAgentToken } from "../src/lib/nodeAuth";

// Colour only when a human is watching; piped output stays clean.
const tty = Boolean(process.stdout.isTTY);
const BOLD = tty ? "\u001b[1m" : "";
const DIM = tty ? "\u001b[2m" : "";
const OFF = tty ? "\u001b[0m" : "";

async function list() {
  const nodes = await prisma.vPNNode.findMany({
    include: { region: true },
    orderBy: [{ region: { sortOrder: "asc" } }, { hostname: "asc" }],
  });

  if (nodes.length === 0) {
    console.log("No nodes registered. Run `npm run seed` first.");
    return;
  }

  console.log(`\n${BOLD}Registered nodes${OFF}\n`);
  for (const n of nodes) {
    const token = n.agentTokenHash ? "token minted" : "NO TOKEN — agent cannot connect";
    const seen = n.lastSeenAt ? `last seen ${n.lastSeenAt.toISOString()}` : "never reported";
    console.log(`  ${BOLD}${n.hostname}${OFF}  ${DIM}${n.region.name}${OFF}`);
    console.log(`    id        ${n.id}`);
    console.log(`    endpoint  ${n.publicIp}:${n.listenPort}`);
    console.log(`    subnet    ${n.subnetBase}.0/24`);
    console.log(`    status    ${n.status} · ${token} · ${seen}`);
    console.log();
  }
}

async function mint(selector: string) {
  // Accept either the uuid or the hostname, because the hostname is the thing
  // a person actually has in front of them when they are stood in a terminal
  // on the droplet.
  const node =
    (await prisma.vPNNode.findUnique({ where: { id: selector }, include: { region: true } })) ??
    (await prisma.vPNNode.findFirst({ where: { hostname: selector }, include: { region: true } }));

  if (!node) {
    console.error(`\nNo node matches ${JSON.stringify(selector)}.`);
    console.error("Run `npm run node:token -- --list` to see what is registered.\n");
    process.exitCode = 1;
    return;
  }

  const rotating = node.agentTokenHash !== null;
  const { token, hash } = generateAgentToken();
  await prisma.vPNNode.update({ where: { id: node.id }, data: { agentTokenHash: hash } });

  if (rotating) {
    console.log(
      `\n${BOLD}Rotated${OFF} the token for ${node.hostname}. ` +
        `The previous token stopped working just now — that node's agent will fail\n` +
        `every call until it is restarted with the new one.`
    );
  }

  console.log(`\n${BOLD}Agent token for ${node.hostname} (${node.region.name})${OFF}`);
  console.log(`${DIM}Shown once. Only its SHA-256 is stored, so this cannot be recovered later.${OFF}\n`);
  console.log(`  TICKVPN_NODE_ID=${node.id}`);
  console.log(`  TICKVPN_NODE_TOKEN=${token}\n`);
  console.log(`${DIM}Install the agent on the droplet with:${OFF}`);
  console.log(`  scp -r backend/node-agent root@${node.publicIp}:/opt/tickvpn-agent`);
  console.log(`  ssh root@${node.publicIp}`);
  console.log(`  TICKVPN_API_URL=https://your-api-host \\`);
  console.log(`  TICKVPN_NODE_ID=${node.id} \\`);
  console.log(`  TICKVPN_NODE_TOKEN=${token} \\`);
  console.log(`    bash /opt/tickvpn-agent/install-agent.sh\n`);
}

async function main() {
  const arg = process.argv[2];

  if (!arg || arg === "--help" || arg === "-h") {
    console.log(`
Mint a bearer token for a VPN node.

  npm run node:token -- --list          show every registered node
  npm run node:token -- <id|hostname>   mint (or rotate) that node's token

Reads DATABASE_URL from the environment, the same as the API.
`);
    return;
  }

  if (arg === "--list" || arg === "-l") return list();
  return mint(arg);
}

main()
  .catch((e) => {
    console.error("\n" + (e instanceof Error ? e.message : String(e)) + "\n");
    process.exitCode = 1;
  })
  .finally(() => disconnect());
