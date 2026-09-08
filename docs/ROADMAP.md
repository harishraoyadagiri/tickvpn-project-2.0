# Roadmap — everything between here and taking real money

The code in this repo works. A customer can sign in, buy time, provision a
device, connect through a WireGuard node, have minutes deducted while they are
actually carrying traffic, and be disconnected when the balance hits zero.

What is missing is not code. It is a payment processor, a domain, real servers,
and the operational scaffolding you need before strangers depend on you.

This document is the sequence. **Do the phases in order** — the ordering is not
arbitrary, it is driven by lead times. Stripe underwriting and domain
reputation both take weeks of calendar time and neither can be rushed at the
end, so both start on day one while you build everything else.

Each step says who does it: **you** (an account, a decision, money) or **code**
(something that can be built once the decision is made).

> Looking for the checklist rather than the reasoning?
> **[`GO-LIVE.md`](GO-LIVE.md)** is the same work as numbered steps with the
> exact commands and configuration values. This document explains why the order
> is what it is; that one is the order itself.

---

## Phase 0 — The two clocks that start now

Everything in this phase is waiting-time. Start it before you write another
line of code.

### 0.1 Register a business entity — *you*

Stripe will not underwrite a VPN service without one. A sole proprietorship is
usually enough to begin; check what your jurisdiction requires. You will need:

- [ ] The entity registered
- [ ] A business bank account in the entity's name
- [ ] Tax identification (EIN in the US, equivalent elsewhere)

**Why first:** every later step in Phase 1 depends on it, and registration can
take days to weeks.

### 0.2 Decide the jurisdiction — *you*

Where is the entity based, and where will customer data live? An EU node plus
EU customers means GDPR applies to you regardless of where you are.

This is a business decision with legal consequences, and it determines what
your privacy policy can say. Do not defer it: the policy is a Stripe
prerequisite.

### 0.3 Decide data retention — *you*

`01_Technical_Decisions.md` (D8) proposes:

| Retain | For | Never retain |
|---|---|---|
| user ID ↔ node ↔ device public key ↔ session timestamps ↔ signup IP | 14 days | DNS queries, destination IPs, packet contents, browsing history |

You need this in writing before the privacy policy can be written, and the
purge job in Phase 5 implements whatever you decide.

**Do not use the phrase "no logs".** You keep logs — you have to, to answer a
DMCA notice that says "which customer held this IP at this time". Saying
precisely what you keep and for how long is a stronger trust signal than a
claim a competitor's audit could dismantle.

### 0.4 Buy the domain and set up mail DNS — *you*

- [ ] Buy the domain
- [ ] SPF, DKIM and DMARC records for the sending domain
- [ ] Verify the domain with your email provider

**Why now:** domain reputation is built over weeks. Magic links landing in spam
is the single most likely cause of a broken activation funnel, and you cannot
fix it the day before launch.

---

## Phase 1 — Stripe

### 1.1 Publish the legal documents — *you (with a lawyer)*

Stripe requires all four to be live on your domain before they will review you:

- [ ] Terms of Service
- [ ] Acceptable Use Policy — this is the one that matters for a VPN. Say
      explicitly that torrenting copyrighted material, port scanning, spam and
      any illegal use will get an account suspended.
- [ ] Privacy Policy — must match the retention decision from 0.3
- [ ] Refund policy

Draft them with AI if you like, but **have a lawyer review them before
publishing**. This is the one place where being wrong is expensive and
AI-generated text is not a defence.

### 1.2 Publish a landing page — *you*

Stripe reviewers want to see a real site describing a real product. The
frontend in this repo is enough; deploy it (Phase 3) and point the domain at
it.

### 1.3 Apply to Stripe — *you*

- [ ] Create the account, business details, bank account
- [ ] Submit for review
- [ ] Expect questions. VPN services get extra scrutiny — that is normal.

**If Stripe declines**, identify a backup processor now rather than later.
Paddle and Lemon Squeezy act as merchant of record and are usually more
tolerant of this category, at a higher fee.

### 1.4 Create the products — *code, 30 minutes*

Once the account is live, the catalogue in `backend/prisma/seed.ts` needs
matching Stripe prices. Today `POST /checkout` creates prices inline with
`price_data`, which works but means Stripe's dashboard has no product
analytics. Either is defensible; if you want real reporting, create Products
and Prices in Stripe and store their ids in `Product.stripePriceId` (the column
already exists and is unused).

### 1.5 Wire the webhook — *you + code*

```bash
# local testing, no deploy needed
stripe listen --forward-to localhost:3001/webhooks/stripe
# copy the whsec_... it prints into backend/.env as STRIPE_WEBHOOK_SECRET
```

Then in the Stripe dashboard, add a webhook endpoint at
`https://api.yourdomain.com/webhooks/stripe` subscribing to:

- `checkout.session.completed`
- `charge.refunded`
- `charge.dispute.created`

All three are already handled in `backend/src/routes/checkout.ts`.

**Verify before you trust it:**

```bash
stripe trigger checkout.session.completed   # run it twice with the same event
```

The wallet must move exactly once. `backend/tests/regressions.ts` covers this
offline, including the case where `payment_status` is `unpaid` — which must
credit nothing.

---

## Phase 2 — Infrastructure as code

### 2.1 DigitalOcean account — *you*

- [ ] Account, payment method
- [ ] A **read/write API token** for Terraform. It lives in Terraform and CI
      only. Per D7 it must never reach the application runtime — the app has no
      reason to call DigitalOcean's API at request time, because nodes are
      pre-provisioned rather than created per customer.
- [ ] A Spaces bucket for Terraform state, with versioning on. Never keep state
      locally and never commit it.

### 2.2 Write the Terraform — *code, ~2 days*

Not yet in this repo. It needs to create:

```
infra/terraform/
  project.tf      DigitalOcean project grouping every resource
  vpc.tf          A VPC for the app and database
  vpc-nodes.tf    A SEPARATE VPC for the VPN nodes
  database.tf     Managed PostgreSQL 16, daily backups, PITR
  app.tf          App Platform service for the API + the frontend
  nodes.tf        3 x s-1vcpu-1gb droplets, Ubuntu 24.04
  firewall.tf     Inbound: 51820/udp and 22/tcp from your IP only
  dns.tf          A records, and the mail records from 0.4
  spaces.tf       Terraform state backend
```

**The separation matters.** D7: treat every VPN node as potentially hostile. A
node holds nothing but device public keys and a bearer token scoped to its own
peer set. Nodes go in their own VPC with **no network path to the database or
the app**. If a node is compromised, the blast radius is that node's peers.

### 2.3 The node image — *code, ~1 day*

A cloud-init template that produces a node ready for `install-agent.sh`:

- [ ] Ubuntu 24.04, `wireguard-tools`, `nftables`, unattended-upgrades
- [ ] SSH keys only, root password login disabled
- [ ] A non-logging DNS resolver
- [ ] `wg0` configured with the node's private key, listening on 51820
- [ ] Outbound 25 / 465 / 587 blocked — `install-agent.sh` does this, but bake
      it into the image so it is true before the agent ever runs
- [ ] Per-peer outbound connection rate limiting, to blunt port scanning

### 2.4 Bring up one node and register it — *you*

```bash
cd infra/terraform && terraform apply

# register it in the control plane (admin action; today, a dev route)
#   hostname, publicIp, publicKey (from `wg show wg0 public-key`), region

# mint its agent token — shown once, stored only as a SHA-256 hash
curl -X POST https://api.yourdomain.com/dev/nodes/<node-id>/token

# install the agent
scp -r backend/node-agent root@<droplet>:/opt/tickvpn-agent
ssh root@<droplet>
TICKVPN_API_URL=https://api.yourdomain.com \
TICKVPN_NODE_ID=<node uuid> \
TICKVPN_NODE_TOKEN=<the token> \
  bash /opt/tickvpn-agent/install-agent.sh
```

**Exit criterion:** connect your own phone through the node and confirm
`curl ifconfig.me` returns an IP in the expected country. Then let the balance
run out and confirm the tunnel actually stops.

### 2.5 Scale to three regions — *code, minutes*

Changing a Terraform variable should be all it takes. If it requires code
changes, the module is wrong.

---

## Phase 3 — Deploy

### 3.1 Environment configuration — *you*

The API refuses to start on invalid configuration, which is deliberate. In
production it requires:

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Disables dev routes unconditionally |
| `APP_URL` | `https://app.yourdomain.com` | The **frontend's** URL. Magic links, Stripe redirects and the CORS allowlist all derive from it. Pointing it at the API's own port breaks sign-in three ways, so the server refuses to start if you do. |
| `CORS_ALLOWED_ORIGINS` | the frontend origin | Never `*` |
| `COOKIE_SECURE` | `true` | Enforced in production |
| `COOKIE_SAMESITE` | `lax` — **unless** the frontend and API are on different registrable domains, then `none` | A Vercel URL calling a DigitalOcean API is cross-site; browsers never attach a Lax cookie and every logged-in request silently 401s |
| `DATABASE_URL` | the `tickvpn_app` role | Not a superuser. The boot check refuses to start otherwise. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | live values | Required in production |
| `EMAIL_PROVIDER` | `resend` or `smtp` | `console` is refused in production |
| `EMAIL_ALLOWLIST` | *empty* | Remove it once DNS is verified, or real customers get no mail |

### 3.2 Database — *you + code*

- [ ] Managed PostgreSQL 16 (do **not** self-host on a droplet — backups and
      point-in-time recovery are worth more than the saving)
- [ ] Run `backend/prisma/sql/app_role.sql` once as a superuser
- [ ] `npm run prisma:migrate` on deploy, then re-run `app_role.sql` so the
      role has rights on newly created tables
- [ ] **Test a restore.** An untested backup is a rumour. Restore into a
      scratch database and run the regression suite against it.

### 3.3 Deploy the API and the frontend — *you*

- [ ] API on App Platform, autodeploying from `main`
- [ ] Frontend with `NEXT_PUBLIC_API_URL` pointing at the API
- [ ] TLS on both (Let's Encrypt via App Platform)
- [ ] Confirm the security headers survive your CDN — `frame-ancestors`,
      `nosniff`, HSTS. Some proxies strip them.

### 3.4 Verify in a browser — *you*

```bash
npm --prefix frontend run test:ui   # point FE= at the deployed URL
```

The browser smoke test is the only thing that catches a CORS or cookie
misconfiguration. Server-side tests all passed while the app was completely
unusable in a browser — that is exactly the failure this catches.

---

## Phase 4 — Admin portal

**Not built.** Today, operating this product means writing SQL by hand, which
does not survive contact with a real support request.

### 4.1 Admin identity — *code, ~1 day*

- [ ] An `Admin` model, or a role column on `User`
- [ ] **MFA required** — PRD §15 and §17 both call for it
- [ ] An `AuditEvent` table: actor, action, target, before/after, timestamp
- [ ] Every privileged action writes an audit event. No exceptions.

### 4.2 Read-only views first — *code, ~2 days*

Ship these before any action, because most support requests are questions:

- [ ] Users: email, status, wallet balance, devices, sessions
- [ ] Wallet ledger, filterable by user — with the running balance visible
- [ ] Purchases and refunds, reconciled against Stripe
- [ ] Active sessions and current bandwidth
- [ ] Nodes: health, peer count, capacity, last report

### 4.3 Actions — *code, ~2 days*

Each one an audit event, each one reversible where possible:

- [ ] Suspend / restore a user — suspension already flows through
      `requireAuth` and the peer-set query, so it disconnects them too
- [ ] Credit or reverse minutes — through `applyWalletTransaction`, never a
      direct `UPDATE`. Corrections are `REVERSAL` rows.
- [ ] Revoke a device
- [ ] Drain a node (stop new peers, migrate existing ones)
- [ ] Record an abuse case against a user

### 4.4 Abuse response — *code + you*

You will get DMCA notices, port-scanning complaints and spam reports.
DigitalOcean forwards them and expects an answer.

- [ ] A documented workflow: notice arrives → identify the customer from
      retained metadata → suspend or warn → reply within the deadline
- [ ] `abuse@yourdomain.com`, monitored
- [ ] A runbook so this happens the same way every time

---

## Phase 5 — Monitoring and retention

### 5.1 Error tracking — *you + code, half a day*

- [ ] Sentry on the API and the frontend
- [ ] **Scrub before send.** Never let a WireGuard key, session token, node
      token or Stripe secret reach a third party. Configure the scrubber and
      then verify it by triggering a deliberate error.

### 5.2 Alerts that mean something — *code, ~1 day*

Alert on things that need a human, not on things that are merely interesting:

| Alert | Threshold | Why it matters |
|---|---|---|
| A node stops reporting | no report for 2 min | Its customers are billed but may not be connected |
| Stripe webhook failures | any | Someone paid and got nothing |
| `wallet_minute_balance_non_negative` fires | ever | Sev-1. Something bypassed the service layer. |
| Ledger sum ≠ wallet balance | nightly check | The money is wrong |
| API 5xx rate | > 1% for 5 min | |
| Sessions ending `abandoned` | spike | The agent or the node is broken |

### 5.3 Uptime — *you*

- [ ] External checks on the API, the frontend, and a real handshake through
      each node. Better Stack or Uptime Kuma.
- [ ] Status page, even a simple one

### 5.4 Retention purge — *code, ~half a day*

This is a legal commitment once the privacy policy is published, and there is
no job today.

- [ ] A scheduled task in `backend/src/scheduler.ts` deleting operational
      metadata older than the retention window from 0.3
- [ ] Keep the wallet ledger — that is financial record-keeping, a different
      obligation with a different (longer) retention period. Purge the
      *connection* metadata, not the money.
- [ ] Account deletion on request, and data export. GDPR gives both as rights
      if 0.2 put you in scope.
- [ ] Log what was purged and when, so you can demonstrate compliance

---

## Phase 6 — Beta

Do not skip stages. The credit model is the unvalidated hypothesis in this
whole product, and 25 real users will tell you more about it than any amount of
internal testing.

| Stage | Users | What you are actually measuring |
|---|---|---|
| Internal | 5 | Does the connection stay up for a week? |
| Private beta | 25 | Where does setup break, and does metered billing feel fair? |
| Paid beta | 100 | Will strangers pay? |
| Public | open | CAC, activation, repeat purchase |

Before the paid beta, all ten acceptance criteria in PRD §21 must pass, the
restore drill must be done, and the runbooks must be written.

---

## Ranked risks

1. **Stripe declines or delays underwriting.** Highest impact, longest lead
   time, and the reason Phase 0 and 1 start immediately.
2. **Abuse gets you de-platformed by DigitalOcean.** Egress controls and a fast
   abuse response from day one, not after the first complaint.
3. **The metered model does not resonate.** Cheapest to test — that is what the
   private beta is for.
4. **Magic links land in spam.** Kills activation silently. Domain reputation
   work starts in Phase 0 for this reason.
5. **A billing bug leaks or over-charges credits.** The database constraints and
   the regression suite exist for this; keep CI green and never merge past a
   red `Backend tests` job.

---

## What is genuinely done

So the list above is not read as "nothing works":

- Metered billing: minutes deducted only while a device carries real traffic,
  measured on the node, verified against a real WireGuard tunnel
- Atomic, idempotent wallet with an append-only ledger the application role
  cannot rewrite — enforced by database grants, not convention
- Peer-set authorization: a zero balance removes the peer from the interface
  within one reconcile pass
- Passwordless auth with server-side sessions, hashed tokens and rate limiting
- Stripe checkout, signature verification, event de-duplication, refunds and
  disputes
- An outbound-only node agent with per-node bearer tokens and no inbound port
- CI running the regression suite, a real tunnel test and a browser test on
  every push
