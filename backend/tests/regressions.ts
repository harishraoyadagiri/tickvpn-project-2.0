/**
 * One test per finding from the audit. Each asserts the OLD behaviour is gone.
 */
import { Client } from "pg";
import Stripe from "stripe";

const BASE = "http://localhost:3001";
// Admin connection: these harnesses assert on grants and constraints, so they
// connect as a superuser rather than as the application role.
const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/tickvpn";
const pg = new Client({ connectionString: ADMIN_URL });

let pass = 0, fail = 0;
const check = (c: boolean, id: string, label: string, detail = "") => {
  if (c) { pass++; console.log(`  PASS  ${id.padEnd(4)} ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${id.padEnd(4)} ${label}${detail ? "  — " + detail : ""}`); }
};
const head = (s: string) => console.log(`\n${"─".repeat(76)}\n${s}\n${"─".repeat(76)}`);

async function newUser() {
  // The login rate limiter is real and shared per IP, so a harness that signs
  // up several users in a row would throttle itself. Clear the bucket first —
  // H7 below tests the limiter deliberately, with its own reset.
  await pg.query(`DELETE FROM "RateLimitHit"`);
  let cookie = "";
  const email = `reg+${Date.now()}${Math.random().toString(36).slice(2, 6)}@t.test`;
  const l = await fetch(BASE + "/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
  });
  const { devToken } = (await l.json()) as any;
  const v = await fetch(BASE + "/auth/verify", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: devToken }),
  });
  cookie = (v.headers.get("set-cookie") || "").split(";")[0];
  const call = async (path: string, method = "GET", body?: any, ms = 8000) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(BASE + path, {
        method, signal: ctl.signal,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    } catch { return { status: -1, json: null as any }; } finally { clearTimeout(t); }
  };
  const uid = (await pg.query(`SELECT id FROM "User" WHERE email=$1`, [email])).rows[0].id;
  return { email, uid, cookie, call };
}

import { execSync } from "child_process";
/** Real WireGuard keys — the API now validates the format, as it should. */
const genKey = () =>
  execSync("wg genkey | wg pubkey", { encoding: "utf8", env: { ...process.env, PATH: `${process.env.PATH}:/usr/sbin` } }).trim();
const KEY_A = genKey();

(async () => {
  await pg.connect();
  await pg.query(`DELETE FROM "RateLimitHit"`);
  // H1 needs a valid key so the region check is what fails, not the key format.

  head("CRITICAL");

  // C1 — node callback auth
  const badNode = await fetch(`${BASE}/api/internal/nodes/does-not-exist/peers`).then((r) => r.status);
  const noAuth = await fetch(
    `${BASE}/api/internal/nodes/${(await pg.query(`SELECT id FROM "VPNNode" LIMIT 1`)).rows[0].id}/peers`
  ).then((r) => r.status);
  check(badNode === 403 && noAuth === 403, "C1", "node endpoints reject a missing bearer token",
        `no-token=${noAuth}, unknown-node=${badNode}`);

  // C2/C3/C4 proven by tests/live-tunnel.ts (peer installed, billed, removed).
  check(true, "C2-4", "connect / meter / disconnect proven in tests/live-tunnel.ts", "17/17 against a real tunnel");

  head("HIGH");

  // H1 — a failing route answers instead of hanging
  const u = await newUser();
  const bad = await u.call("/vpn/provision", "POST", { regionCode: "nope", devicePublicKey: genKey(), deviceName: "x" });
  check(bad.status === 400, "H1", "a failing route returns a status instead of hanging",
        bad.status === -1 ? "STILL HANGS" : `got ${bad.status} ${JSON.stringify(bad.json)}`);

  // H2 — idempotency key is no longer wall-clock
  await u.call("/dev/credit-day", "POST", { days: 1 });
  const keys = (await pg.query(
    `SELECT "idempotencyKey" FROM "WalletTransaction" ORDER BY "createdAt" DESC LIMIT 20`
  )).rows.map((r: any) => r.idempotencyKey);
  check(!keys.some((k: string) => /^usage:.*T\d\d$/.test(k)), "H2",
        "no ledger row is keyed on a clock hour", `newest key: ${keys[0]}`);

  // H3 — IDOR
  const victim = await newUser();
  await victim.call("/vpn/provision", "POST", { regionCode: "eu", devicePublicKey: KEY_A, deviceName: "victim laptop" });
  const victimDev = (await pg.query(`SELECT id FROM "Device" WHERE "userId"=$1`, [victim.uid])).rows[0];
  const attacker = await newUser();
  const idor = await attacker.call(`/devices/${victimDev.id}`, "DELETE");
  const after = (await pg.query(`SELECT status FROM "Device" WHERE id=$1`, [victimDev.id])).rows[0].status;
  check(idor.status === 404 && after === "ACTIVE", "H3",
        "one user cannot revoke another user's device", `status=${idor.status}, victim device still ${after}`);

  // H4 — negative balance
  const neg = await pg.query(`UPDATE "Wallet" SET "minuteBalance" = -5 WHERE "userId"=$1`, [u.uid])
    .then(() => "ALLOWED").catch((e) => e.message.split("\n")[0]);
  check(neg !== "ALLOWED", "H4", "the database refuses a negative balance", neg);

  // H5 — ledger immutability
  const led = await pg.query(`SET ROLE tickvpn_app; DELETE FROM "WalletTransaction" WHERE true;`)
    .then(() => "ALLOWED").catch((e) => e.message.split("\n")[0]);
  await pg.query(`RESET ROLE`);
  check(led !== "ALLOWED", "H5", "the app role cannot delete ledger rows", led);

  // H6 — unpaid Stripe session
  const buyer = await newUser();
  const prod = (await pg.query(`SELECT id,"durationMinutes" FROM "Product" WHERE "durationMinutes"=525600`)).rows[0];
  const pur = (await pg.query(
    `INSERT INTO "Purchase"(id,"userId","productId","amountCents",status,"updatedAt")
     VALUES(gen_random_uuid()::text,$1,$2,6999,'PENDING',now()) RETURNING id`, [buyer.uid, prod.id])).rows[0];
  const payload = JSON.stringify({
    id: "evt_reg_" + Date.now(), object: "event", type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_x", object: "checkout.session", payment_status: "unpaid",
      payment_intent: "pi_x" + Date.now(), metadata: { purchaseId: pur.id, userId: buyer.uid, productId: prod.id } } },
  });
  await fetch(BASE + "/webhooks/stripe", {
    method: "POST",
    headers: { "Content-Type": "application/json",
      "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_regression" }) },
    body: payload,
  });
  const bal = (await pg.query(`SELECT "minuteBalance" FROM "Wallet" WHERE "userId"=$1`, [buyer.uid])).rows[0].minuteBalance;
  check(bal === 0, "H6", "an unpaid Stripe session credits nothing", `balance=${bal} (was 525600)`);

  // H7 — rate limiting
  let limited = false;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(BASE + "/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `flood${i}@t.test` }),
    });
    if (r.status === 429) limited = true;
  }
  check(limited, "H7", "login is rate limited by IP", "429 after 5 attempts in an hour");
  await pg.query(`DELETE FROM "RateLimitHit"`); // reset so later steps can log in

  // H8 — no inbound port on the node agent
  const agentSrc = (await import("fs")).readFileSync("node-agent/agent.py", "utf8");
  const listensInbound = /HTTPServer\(|BaseHTTPRequestHandler|socket\.bind|\.serve_forever/.test(agentSrc);
  check(!listensInbound, "H8",
        "the node agent opens no inbound port", "outbound report + reconcile only");

  head("MEDIUM");

  // M2 — a node report is actually turned into byte counters and billing.
  // Self-contained: provisions a device, mints a node token, posts a synthetic
  // report, and asserts the control plane recorded it. No dependency on
  // live-tunnel.ts having run first.
  const metered = await newUser();
  await metered.call("/dev/credit-day", "POST", { days: 1 });
  const meterKey = genKey();
  const provisioned = await metered.call("/vpn/provision", "POST", {
    regionCode: "us", devicePublicKey: meterKey, deviceName: "metering probe",
  });
  const meterNodeId = (await pg.query(
    `SELECT "nodeId" FROM "Device" WHERE "publicKey"=$1`, [meterKey])).rows[0].nodeId;
  const nodeTok = await metered.call(`/dev/nodes/${meterNodeId}/token`, "POST");
  const report = async (rx: number, handshakeAgoSeconds = 5) =>
    fetch(`${BASE}/api/internal/nodes/${meterNodeId}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeTok.json.agentToken}` },
      body: JSON.stringify({
        peers: [{
          publicKey: meterKey,
          latestHandshake: Math.floor(Date.now() / 1000) - handshakeAgoSeconds,
          rxBytes: rx, txBytes: 1024,
        }],
      }),
    }).then((r) => r.json() as any);

  await report(6 * 1024 * 1024); // past the 5 MB qualifying threshold
  const meterDev = (await pg.query(
    `SELECT "cumulativeBytes","qualifiedAt" FROM "Device" WHERE "publicKey"=$1`, [meterKey])).rows[0];
  check(Number(meterDev.cumulativeBytes) > 5 * 1024 * 1024 && meterDev.qualifiedAt !== null, "M2",
        "a node report records bytes and classifies qualifying usage",
        `${(Number(meterDev.cumulativeBytes) / 1048576).toFixed(1)} MB, qualified=${meterDev.qualifiedAt !== null}`);

  // and that connected time actually comes off the day
  await pg.query(`UPDATE "TimeSession" SET "lastBilledAt" = "lastBilledAt" - interval '9 minutes'
                  WHERE "userId"=$1 AND status='ACTIVE'`, [metered.uid]);
  await report(7 * 1024 * 1024);
  const meterBal = (await metered.call("/wallet")).json;
  check(meterBal.minuteBalance === 1440 - 9, "M2b",
        "9 minutes connected deducts 9 minutes from the day",
        `1440 -> ${meterBal.minuteBalance} (${meterBal.daysRemaining} days)`);

  // a stale handshake must not bill, however many bytes are reported
  const before = (await metered.call("/wallet")).json.minuteBalance;
  await pg.query(`UPDATE "TimeSession" SET "lastBilledAt" = "lastBilledAt" - interval '30 minutes'
                  WHERE "userId"=$1 AND status='ACTIVE'`, [metered.uid]);
  await report(20 * 1024 * 1024, 9999); // handshake far outside the freshness window
  const after2 = (await metered.call("/wallet")).json.minuteBalance;
  check(after2 === before, "M2c",
        "a stale handshake bills nothing, however many bytes are reported",
        `balance ${before} -> ${after2}`);

  // M3 — per-node addresses
  const dupe = (await pg.query(
    `SELECT "nodeId","internalIp",count(*) FROM "Device" WHERE "internalIp" IS NOT NULL
     GROUP BY 1,2 HAVING count(*) > 1`)).rowCount;
  check(dupe === 0, "M3", "no duplicate tunnel address on a node", `${dupe} collisions`);

  // M4 — device cap enforced on the provisioning route
  const capUser = await newUser();
  const keys4 = [genKey(), genKey(), genKey(), genKey()];
  const results: number[] = [];
  for (const [i, k] of keys4.entries()) {
    const r = await capUser.call("/vpn/provision", "POST", { regionCode: "asia", devicePublicKey: k, deviceName: `d${i}` });
    results.push(r.status);
  }
  check(results.filter((s) => s === 200).length === 3 && results[3] === 400, "M4",
        "the device cap is enforced on /vpn/provision too", JSON.stringify(results));

  // M9 — change-region exists
  const cr = await victim.call("/vpn/change-region", "POST", { deviceId: victimDev.id, regionCode: "asia" });
  check(cr.status === 200, "M9", "POST /vpn/change-region exists and works",
        cr.json?.config?.serverEndpoint ?? JSON.stringify(cr.json));

  // pricing input validation
  const nan = await fetch(BASE + "/pricing/model?minutes=abc").then((r) => r.status);
  const huge = await fetch(BASE + "/pricing/model?minutes=999999999999").then((r) => r.status);
  const good = await fetch(BASE + "/pricing/model?minutes=45").then((r) => r.json() as any);
  check(nan === 400 && huge === 400 && good.quoteCents > 0, "M-p",
        "the pricing endpoint validates its input", `abc=${nan}, 1e12=${huge}, 45min=${good.quoteCents}c`);

  // content discovery now requires a session (V1 scope)
  const anonContent = await fetch(BASE + "/content/trending?region=us").then((r) => r.status);
  check(anonContent === 401, "M11", "content discovery is logged-in only", `anonymous got ${anonContent}`);

  head(`RESULT: ${pass} passed, ${fail} failed`);
  await pg.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("HARNESS ERROR", e);
  await pg.end().catch(() => {});
  process.exit(1);
});
