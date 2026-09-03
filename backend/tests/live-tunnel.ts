/**
 * End-to-end proof against a REAL WireGuard tunnel.
 *
 *   account holds a day's pass  ->  connects to a region  ->  time used is
 *   deducted  ->  balance runs out  ->  the peer is actually removed and the
 *   tunnel stops carrying traffic.
 *
 * Nothing here is simulated except the passage of time, which is fast-forwarded
 * by moving lastBilledAt backwards — the same value the metering code reads.
 */
import { execFileSync } from "child_process";
import { Client } from "pg";

const BASE = "http://localhost:3001";
const ADMIN = "postgresql://postgres:password@localhost:5432/tickvpn";
const pg = new Client({ connectionString: ADMIN });

const SERVER_PUBKEY = execFileSync("cat", ["/tmp/s.pub"]).toString().trim();
const CLIENT_PUBKEY = execFileSync("cat", ["/tmp/c.pub"]).toString().trim();

const sh = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, PATH: `${process.env.PATH}:/usr/sbin` } });

const wg = (...a: string[]) => sh("wg", a);
const nsExec = (...a: string[]) => sh("ip", ["netns", "exec", "cli", ...a]);

let cookie = "";
let pass = 0;
let fail = 0;

function check(cond: boolean, label: string, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
}
const head = (s: string) => console.log(`\n${"─".repeat(76)}\n${s}\n${"─".repeat(76)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, method = "GET", body?: any) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setC = res.headers.get("set-cookie");
  if (setC) cookie = setC.split(";")[0];
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

/** wg0 peer list, as the agent sees it. */
function peersOnInterface(): string[] {
  return wg("show", "wg0", "dump")
    .split("\n")
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => l.split("\t")[0]);
}

(async () => {
  await pg.connect();

  // ── 0. point the "us" node at the real local WireGuard interface ──
  head("0  WIRE THE 'us' REGION TO THE REAL WIREGUARD INTERFACE");
  const node = (
    await pg.query(
      `UPDATE "VPNNode" n SET "publicIp"='127.0.0.1', "publicKey"=$1, "subnetBase"='10.8.0'
       FROM "Region" r WHERE r.id = n."regionId" AND r.code='us' RETURNING n.id, n.hostname`,
      [SERVER_PUBKEY]
    )
  ).rows[0];
  console.log(`  node ${node.hostname} -> 127.0.0.1:51820, server key ${SERVER_PUBKEY.slice(0, 16)}…`);

  const tok = await api(`/dev/nodes/${node.id}/token`, "POST");
  const agentToken: string = tok.json.agentToken;
  check(!!agentToken, "minted a per-node agent token", `${agentToken.slice(0, 12)}…`);

  // clear any peers and device rows left from earlier runs
  for (const k of peersOnInterface()) wg("set", "wg0", "peer", k, "remove");
  await pg.query(`DELETE FROM "TimeSession" WHERE "deviceId" IN (SELECT id FROM "Device" WHERE "publicKey"=$1)`, [CLIENT_PUBKEY]);
  await pg.query(`DELETE FROM "Device" WHERE "publicKey"=$1`, [CLIENT_PUBKEY]);

  // ── 1. sign up and buy a day ──
  head("1  ACCOUNT WITH A DAY'S WORTH OF PASS");
  // The login rate limiter is real (5/hour per IP); clear it for the harness.
  await pg.query(`DELETE FROM "RateLimitHit"`);
  const email = `live+${Date.now()}@tickvpn.test`;
  const login = await api("/auth/login", "POST", { email });
  await api("/auth/verify", "POST", { token: login.json.devToken });
  const credited = await api("/dev/credit-day", "POST", { days: 1 });
  check(credited.json.minuteBalance === 1440, "wallet holds one day = 1440 minutes",
        `daysRemaining=${credited.json.daysRemaining}`);

  // ── 2. provision the REAL client key into the US region ──
  head("2  CONNECT TO A REGION");
  const prov = await api("/vpn/provision", "POST", {
    regionCode: "us", devicePublicKey: CLIENT_PUBKEY, deviceName: "Live test laptop",
  });
  check(prov.status === 200, "provisioned against region us", JSON.stringify(prov.json?.config ?? prov.json));
  const internalIp: string = prov.json.config.internalIp;

  // give the client namespace the address the control plane allocated
  const addr = internalIp.split("/")[0];
  try { nsExec("ip", "addr", "flush", "dev", "wg1"); } catch {}
  nsExec("ip", "addr", "add", `${addr}/24`, "dev", "wg1");
  console.log(`  client namespace now uses ${addr}`);

  // ── 3. start the agent; it should install the peer within one reconcile ──
  head("3  NODE AGENT RECONCILES THE PEER ONTO wg0");
  check(peersOnInterface().length === 0, "wg0 starts with no peers");

  const { spawn } = await import("child_process");
  const agent = spawn("python3", ["node-agent/agent.py"], {
    env: {
      ...process.env,
      PATH: `${process.env.PATH}:/usr/sbin`,
      TICKVPN_API_URL: BASE,
      TICKVPN_NODE_ID: node.id,
      TICKVPN_NODE_TOKEN: agentToken,
      TICKVPN_REPORT_INTERVAL: "3",
      TICKVPN_RECONCILE_INTERVAL: "3",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  agent.stdout.on("data", (d) => process.stdout.write("    " + d.toString()));
  agent.stderr.on("data", (d) => process.stdout.write("    ! " + d.toString()));

  await sleep(6000);
  check(peersOnInterface().includes(CLIENT_PUBKEY), "agent installed the authorised peer on wg0");

  // When a peer is re-added server-side the client's old session is dead, and
  // WireGuard only rekeys after roughly two minutes. A real client reconnecting
  // does this itself; here we force it so the test doesn't wait out the timer.
  nsExec("wg", "set", "wg1", "peer", SERVER_PUBKEY, "remove");
  nsExec("wg", "set", "wg1", "peer", SERVER_PUBKEY,
         "endpoint", "172.31.0.1:51820", "allowed-ips", "10.8.0.0/24");
  await sleep(500);

  // ── 4. carry real traffic, past the 5 MB qualifying threshold ──
  head("4  REAL TRAFFIC THROUGH THE TUNNEL");
  const listener = spawn("python3", ["-c",
    `import socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.bind(('10.8.0.1',9999)); s.settimeout(60)
while True:
    try: s.recvfrom(65535)
    except Exception: break`]);
  await sleep(1000);

  // Userspace WireGuard drops UDP under a blast, so send in paced rounds and
  // stop once the server side has actually received past the threshold.
  const rxNow = () => Number(wg("show", "wg0", "dump").split("\n")[1].split("\t")[5] || 0);
  for (let round = 0; round < 25 && rxNow() < 7 * 1024 * 1024; round++) {
    nsExec("python3", "-c",
      `import socket,time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
for i in range(2000):
    s.sendto(b'x'*1200,('10.8.0.1',9999))
    if i%25==0: time.sleep(0.0015)`);
    await sleep(120);
  }
  console.log(`  delivered ${(rxNow() / 1048576).toFixed(1)} MB through the tunnel`);

  const dump = wg("show", "wg0", "dump").split("\n")[1].split("\t");
  console.log(`  wg0 counters: handshake=${dump[4]}  rx=${dump[5]}  tx=${dump[6]}`);
  check(Number(dump[5]) > 5 * 1024 * 1024, "peer moved more than the 5 MB qualifying threshold",
        `${(Number(dump[5]) / 1048576).toFixed(1)} MB`);

  await sleep(5000); // let the agent report it
  const dev = (await pg.query(`SELECT "qualifiedAt","cumulativeBytes" FROM "Device" WHERE "publicKey"=$1`, [CLIENT_PUBKEY])).rows[0];
  check(dev.qualifiedAt !== null, "control plane classified this as qualifying usage",
        `${(Number(dev.cumulativeBytes) / 1048576).toFixed(1)} MB counted`);

  const s1 = await api("/vpn/status");
  check(s1.json.connected === true, "dashboard shows the account as connected");
  check(s1.json.minuteBalance === 1440, "nothing billed yet — under one minute connected",
        `balance=${s1.json.minuteBalance}`);

  // ── 5. time passes; minutes come off the day ──
  head("5  TIME USED IS DEDUCTED FROM THE DAY");
  await pg.query(`UPDATE "TimeSession" SET "lastBilledAt" = "lastBilledAt" - interval '17 minutes' WHERE status='ACTIVE'`);
  await sleep(5000);
  const s2 = await api("/vpn/status");
  check(s2.json.minuteBalance === 1440 - 17, "17 minutes of connection billed 17 minutes",
        `1440 -> ${s2.json.minuteBalance}  (${s2.json.daysRemaining} days left)`);

  // ── 6. run the day out ──
  head("6  THE DAY RUNS OUT");
  await pg.query(`UPDATE "TimeSession" SET "lastBilledAt" = "lastBilledAt" - interval '1500 minutes' WHERE status='ACTIVE'`);
  await sleep(5000);
  const s3 = await api("/vpn/status");
  check(s3.json.minuteBalance === 0, "balance clamped at zero, never negative", `balance=${s3.json.minuteBalance}`);

  const sess = (await pg.query(`SELECT status,"endedReason","minutesBilled" FROM "TimeSession" ORDER BY "startsAt" DESC LIMIT 1`)).rows[0] ?? {};
  check(sess.status === "ENDED" && sess.endedReason === "ran_out",
        "session ended with reason 'ran_out'", `status=${sess.status} reason=${sess.endedReason} billed=${sess.minutesBilled}`);

  // ── 7. the customer is actually disconnected ──
  head("7  THE PEER IS ACTUALLY REMOVED FROM THE INTERFACE");
  const allowed = await fetch(`${BASE}/api/internal/nodes/${node.id}/peers`, {
    headers: { Authorization: `Bearer ${agentToken}` },
  }).then((r) => r.json() as any);
  check(allowed.peers.length === 0, "zero-balance device left the authorised peer set");

  await sleep(6000); // one reconcile pass
  check(!peersOnInterface().includes(CLIENT_PUBKEY),
        "agent removed the peer from wg0 — the tunnel is gone",
        `peers now on wg0: ${peersOnInterface().length}`);

  // ── 8. top up and reconnect ──
  head("8  TOP UP AND RECONNECT");
  await api("/dev/credit-minutes", "POST", { minutes: 30 });
  await sleep(6000);
  check(peersOnInterface().includes(CLIENT_PUBKEY),
        "peer restored automatically after top-up — no re-provisioning needed");

  // ── 9. ledger reconciles ──
  head("9  LEDGER");
  const ledger = await api("/wallet/transactions");
  const sum = ledger.json.reduce((a: number, r: any) => a + r.amount, 0);
  const w = await api("/wallet");
  for (const r of ledger.json.slice(0, 5))
    console.log(`    ${r.type.padEnd(12)} ${String(r.amount).padStart(6)} ${r.balanceBefore} -> ${r.balanceAfter}`);
  check(sum === w.json.minuteBalance, "ledger sums to the wallet balance", `${sum} = ${w.json.minuteBalance}`);

  const canEdit = await pg
    .query(`SET ROLE tickvpn_app; UPDATE "WalletTransaction" SET amount = 1 WHERE true;`)
    .then(() => true)
    .catch((e) => e.message);
  check(canEdit !== true, "the app role cannot rewrite the ledger",
        typeof canEdit === "string" ? canEdit.split("\n")[0] : "IT COULD");

  head(`RESULT: ${pass} passed, ${fail} failed`);
  agent.kill();
  listener.kill();
  await pg.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("\nHARNESS ERROR:", e);
  await pg.end().catch(() => {});
  process.exit(1);
});
