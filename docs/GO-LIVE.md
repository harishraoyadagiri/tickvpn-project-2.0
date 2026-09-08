# Go-live — the step-by-step

This is the do-this-then-that list. Every step is numbered, says **who** does it
(**you** = an account, a decision, or money; **code** = something to build), and
gives the exact command or the exact value where one exists.

[`ROADMAP.md`](ROADMAP.md) explains *why* the order is what it is. This file is
the order itself. If the two ever disagree, ROADMAP is the reasoning and this is
the checklist.

**Read this once before starting step 1.** Two steps have multi-week lead times
(Stripe underwriting, domain reputation) and both are started on day one on
purpose. If you do them last you will sit idle for a month with finished code.

---

## What it costs, and what you need before step 1

| Thing | Where | Rough cost | Needed by |
|---|---|---|---|
| Business entity + bank account | your jurisdiction | varies | Step 4 |
| Domain | any registrar | ~$12/yr | Step 1 |
| Transactional email | Resend free tier | $0 to start | Step 3 |
| Managed PostgreSQL 16 | DigitalOcean | ~$15/mo | Step 8 |
| App Platform (API + web) | DigitalOcean | ~$10/mo | Step 9 |
| 3 × node droplets | DigitalOcean `s-1vcpu-1gb` | ~$18/mo | Step 10 |
| Error tracking | Sentry free tier | $0 to start | Step 14 |
| Uptime checks | Better Stack / Uptime Kuma | $0 to start | Step 15 |

Baseline once live: **roughly $45–50/month** plus Stripe's per-transaction fee.

Tools to install locally: `git`, Node 20+, Docker (or PostgreSQL 16),
`terraform`, `doctl`, the `stripe` CLI, and `wireguard-tools`.

---

# Part A — The two clocks (start today)

## Step 1 — Buy the domain — *you*

Pick it and buy it. Everything below hangs off this name, and changing it later
means redoing Stripe, DNS reputation, TLS and the email allowlist.

- [ ] Domain bought
- [ ] Decide the three hostnames now and write them down:

| Purpose | Suggested | Used in |
|---|---|---|
| Web app | `app.yourdomain.com` | `APP_URL`, `NEXT_PUBLIC_API_URL`'s peer |
| API | `api.yourdomain.com` | `NEXT_PUBLIC_API_URL`, Stripe webhook |
| Marketing / landing | `yourdomain.com` | Stripe review |

> Keep the app and the API on the **same registrable domain**. If you do,
> `COOKIE_SAMESITE=lax` works. If you split them (a Vercel URL calling a
> DigitalOcean API), browsers will not attach the session cookie and every
> logged-in request silently 401s — you would need `COOKIE_SAMESITE=none`, which
> only works on a Secure cookie. Same domain is simply less to go wrong.

## Step 2 — Create the email sender and its DNS — *you*

Do this the same day as step 1. Domain reputation is built over weeks, and magic
links landing in spam is the single most likely way activation breaks silently.

1. Create a [Resend](https://resend.com) account.
2. Add `yourdomain.com` as a sending domain.
3. Resend shows three DNS records. Add all of them at your registrar:
   - [ ] **SPF** — `TXT` on the sending subdomain
   - [ ] **DKIM** — `TXT`, the long key Resend generates
   - [ ] **DMARC** — `TXT` on `_dmarc`, start with `v=DMARC1; p=none; rua=mailto:you@yourdomain.com`
4. Wait for Resend to show the domain **Verified** (minutes to a few hours).
5. Create an API key. It goes in `RESEND_API_KEY` at step 9 — not into git.

Tighten DMARC to `p=quarantine` after a couple of weeks of clean reports.

**Verify:**

```bash
dig +short TXT yourdomain.com          # SPF present
dig +short TXT resend._domainkey.yourdomain.com
dig +short TXT _dmarc.yourdomain.com
```

## Step 3 — Write the retention decision down — *you*

This is a one-page decision, and four later steps depend on it: the privacy
policy (step 5), Stripe's review (step 6), the purge job (step 16), and how you
answer an abuse complaint (step 13).

The proposal from Technical Decisions D8, which you can adopt as-is:

| Retain | For | Never retain |
|---|---|---|
| user id ↔ node ↔ device public key ↔ session timestamps ↔ signup IP | **14 days** | DNS queries, destination IPs, packet contents, browsing history |

- [ ] Retention window chosen and written down
- [ ] Jurisdiction chosen — where the entity is based and where customer data
      lives. An EU node with EU customers means GDPR applies to you regardless
      of where you sit.

> **Do not write "no logs".** You keep logs; you have to, to answer a notice
> that asks which customer held an IP at a given time. Saying exactly what you
> keep and for how long is a stronger claim than one a competitor's audit could
> take apart.

---

# Part B — Money

## Step 4 — Register the entity — *you*

Stripe will not underwrite a VPN without one.

- [ ] Entity registered (a sole proprietorship is usually enough to start)
- [ ] Business bank account in the entity's name
- [ ] Tax ID (EIN in the US, equivalent elsewhere)

## Step 5 — Publish the four legal documents — *you, with a lawyer*

All four must be **live on the domain** before Stripe will review you.

- [ ] **Terms of Service**
- [ ] **Acceptable Use Policy** — the one that matters for a VPN. State plainly
      that torrenting copyrighted material, port scanning, spam and any illegal
      use get an account suspended.
- [ ] **Privacy Policy** — must match step 3 exactly, word for word on the
      retention window.
- [ ] **Refund policy**

Draft them however you like, but have a lawyer review them before publishing.
This is the one place where being wrong is expensive.

## Step 6 — Apply to Stripe — *you*

1. Create the Stripe account with the entity details and bank account from step 4.
2. Point it at the live site and the four documents from step 5.
3. Submit for review.
4. **Expect questions.** VPN services get extra scrutiny; that is normal, not a
   sign something is wrong.

- [ ] Submitted
- [ ] Approved

**If Stripe declines**, do not restart from scratch — Paddle and Lemon Squeezy
act as merchant of record, are usually more tolerant of this category, and cost
a higher fee. Identify your fallback while you wait, not after.

## Step 7 — Wire Stripe up — *you + code, ~1 hour*

Test locally first; no deploy needed.

```bash
stripe login
stripe listen --forward-to localhost:3001/webhooks/stripe
# copy the whsec_... it prints into backend/.env as STRIPE_WEBHOOK_SECRET
```

Then, in the Stripe dashboard, add an endpoint at
`https://api.yourdomain.com/webhooks/stripe` subscribed to exactly these three:

- [ ] `checkout.session.completed`
- [ ] `charge.refunded`
- [ ] `charge.dispute.created`

All three are already handled in `backend/src/routes/checkout.ts`.

**Verify before you trust it — run the same event twice:**

```bash
stripe trigger checkout.session.completed
stripe trigger checkout.session.completed
```

The wallet must move **exactly once**. `backend/tests/regressions.ts` covers
this offline, including the case where `payment_status` is `unpaid`, which must
credit nothing at all.

*Optional (30 min):* today `POST /checkout` creates prices inline with
`price_data`, which works but leaves Stripe's dashboard with no product
analytics. If you want real reporting, create Products and Prices in Stripe and
store the ids in `Product.stripePriceId` — the column exists and is unused.

---

# Part C — Infrastructure

## Step 8 — DigitalOcean and the database — *you + code*

1. Create the account and add a payment method.
2. Create a **read/write API token** for Terraform. It lives in Terraform and CI
   only — per D7 it must **never** reach the application runtime. The app has no
   reason to call DigitalOcean at request time; nodes are pre-provisioned, not
   created per customer.
3. Create a Spaces bucket for Terraform state, **with versioning on**. Never
   keep state locally, never commit it.
4. Create **Managed PostgreSQL 16**. Do not self-host on a droplet — daily
   backups and point-in-time recovery are worth more than the saving.
5. Create the least-privilege role, once, as a superuser:

```bash
psql "$ADMIN_DATABASE_URL" \
  -v app_password="'a-long-random-password'" \
  -v DBNAME=tickvpn \
  -f backend/prisma/sql/app_role.sql
```

6. Apply the schema, then **re-run the role script** — migrations create new
   tables that the role has no rights on until granted:

```bash
cd backend
DATABASE_URL="postgresql://tickvpn_app:...@db-host:25060/tickvpn?sslmode=require" \
  npx prisma migrate deploy
psql "$ADMIN_DATABASE_URL" -v app_password="'...'" -v DBNAME=tickvpn \
  -f prisma/sql/app_role.sql
DATABASE_URL="postgresql://tickvpn_app:...@db-host:25060/tickvpn?sslmode=require" \
  npm run seed
```

7. - [ ] **Test a restore.** An untested backup is a rumour. Restore into a
     scratch database and run the regression suite against it.

## Step 9 — Deploy the API and the web app — *you*

The API refuses to start on invalid configuration. That is deliberate: a missing
variable must never mean "allow". Set these on App Platform:

| Variable | Value | Why it matters |
|---|---|---|
| `NODE_ENV` | `production` | Disables dev routes unconditionally |
| `APP_URL` | `https://app.yourdomain.com` | The **frontend's** URL. Magic links, Stripe redirects and the CORS allowlist all derive from it. Pointing it at the API's own port breaks sign-in three ways — the server refuses to start if you do. |
| `CORS_ALLOWED_ORIGINS` | `https://app.yourdomain.com` | Never `*` |
| `COOKIE_SECURE` | `true` | Enforced in production |
| `COOKIE_SAMESITE` | `lax` | `none` only if you ignored the advice in step 1 |
| `DATABASE_URL` | the `tickvpn_app` URL | Not a superuser. The boot check refuses otherwise. |
| `STRIPE_SECRET_KEY` | live key | Required in production |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` from step 7 | |
| `EMAIL_PROVIDER` | `resend` | `console` is refused in production |
| `EMAIL_FROM` | `TickVPN <noreply@yourdomain.com>` | Must be the domain verified in step 2 |
| `RESEND_API_KEY` | from step 2 | |
| `EMAIL_ALLOWLIST` | **empty** | Leave it set and real customers get no mail |
| `USE_REAL_NODES` | `false` until step 10 lands, then `true` | |

Then:

- [ ] API deployed on App Platform, autodeploying from `main`
- [ ] Frontend deployed with `NEXT_PUBLIC_API_URL=https://api.yourdomain.com`
- [ ] TLS on both (Let's Encrypt via App Platform)
- [ ] DNS `A`/`CNAME` records for all three hostnames from step 1
- [ ] **Confirm the security headers survive your CDN** — some proxies strip
      them:

```bash
curl -sI https://app.yourdomain.com | grep -iE 'content-security|frame|nosniff|strict-transport'
```

## Step 10 — Terraform the network and the nodes — *code, ~2 days*

Not in this repo yet. It needs to create:

```
infra/terraform/
  project.tf      DigitalOcean project grouping every resource
  vpc.tf          VPC for the app and the database
  vpc-nodes.tf    A SEPARATE VPC for the VPN nodes
  database.tf     Managed PostgreSQL 16, daily backups, PITR
  app.tf          App Platform service for the API and the frontend
  nodes.tf        3 x s-1vcpu-1gb droplets, Ubuntu 24.04
  firewall.tf     Inbound: 51820/udp, and 22/tcp from your IP only
  dns.tf          A records, plus the mail records from step 2
  spaces.tf       Terraform state backend
```

**The VPC separation is the point.** D7: treat every VPN node as potentially
hostile. A node holds nothing but device public keys and a bearer token scoped
to its own peer set. Nodes go in their own VPC with **no network path to the
database or the app**. If a node is compromised, the blast radius is that node's
peers and nothing else.

**The node image** (cloud-init, ~1 day) must produce a droplet ready for
`install-agent.sh`:

- [ ] Ubuntu 24.04 with `wireguard-tools`, `nftables`, unattended-upgrades
- [ ] SSH keys only, root password login disabled
- [ ] A non-logging DNS resolver
- [ ] `wg0` up with the node's private key, listening on 51820
- [ ] Outbound 25 / 465 / 587 blocked — `install-agent.sh` does this, but bake
      it into the image so it is true before the agent ever runs
- [ ] Per-peer outbound connection rate limiting, to blunt port scanning

## Step 11 — Bring up the first node — *you*

```bash
cd infra/terraform && terraform apply

# 1. register it in the control plane
#    hostname, publicIp, region, and publicKey from:
ssh root@<droplet> wg show wg0 public-key

# 2. mint its agent token — shown ONCE, stored only as a SHA-256 hash
curl -X POST https://api.yourdomain.com/dev/nodes/<node-id>/token

# 3. install the agent
scp -r backend/node-agent root@<droplet>:/opt/tickvpn-agent
ssh root@<droplet>
TICKVPN_API_URL=https://api.yourdomain.com \
TICKVPN_NODE_ID=<node uuid> \
TICKVPN_NODE_TOKEN=<the token> \
  bash /opt/tickvpn-agent/install-agent.sh
```

**Exit criteria — both, not one:**

- [ ] Connect your own phone through the node; `curl ifconfig.me` returns an IP
      in the expected country
- [ ] Let the balance run out and confirm the tunnel **actually stops** —
      within one reconcile pass (~15s), the peer disappears from `wg show wg0`

Then set `USE_REAL_NODES=true` on the API and redeploy.

## Step 12 — Scale to three regions — *code, minutes*

Changing a Terraform variable should be all it takes. If it needs code changes,
the module is wrong — fix the module rather than copy-pasting it.

- [ ] Three nodes live, one per region in the seed catalogue
- [ ] Run the browser test against production:

```bash
FE=https://app.yourdomain.com npm --prefix frontend run test:ui
```

The browser test is the only thing that catches a CORS or cookie
misconfiguration. Server-side tests all passed once while the app was completely
unusable in a browser — that is exactly the failure this catches.

---

# Part D — Operations

## Step 13 — Admin portal — *code, ~5 days*

Not built. Today, operating this means writing SQL by hand, which does not
survive contact with a real support request.

**13a. Admin identity (~1 day)**

- [ ] An `Admin` model, or a role column on `User`
- [ ] **MFA required** — PRD §15 and §17 both call for it
- [ ] An `AuditEvent` table: actor, action, target, before/after, timestamp
- [ ] Every privileged action writes an audit event. No exceptions.

**13b. Read-only views first (~2 days)** — ship these before any action, because
most support requests are questions:

- [ ] Users: email, status, wallet balance, devices, sessions
- [ ] Wallet ledger, filterable by user, with a running balance
- [ ] Purchases and refunds, reconciled against Stripe
- [ ] Active sessions and current bandwidth
- [ ] Nodes: health, peer count, capacity, last report

**13c. Actions (~2 days)** — each one audited, each reversible where possible:

- [ ] Suspend / restore a user — suspension already flows through `requireAuth`
      *and* the peer-set query, so it disconnects them too
- [ ] Credit or reverse minutes — through `applyWalletTransaction`, **never** a
      direct `UPDATE`. Corrections are `REVERSAL` rows.
- [ ] Revoke a device
- [ ] Drain a node (stop new peers, migrate existing ones)
- [ ] Record an abuse case against a user

**13d. Abuse response** — you will get DMCA notices, port-scanning complaints
and spam reports, and DigitalOcean forwards them expecting an answer:

- [ ] `abuse@yourdomain.com`, monitored
- [ ] A written workflow: notice arrives → identify the customer from retained
      metadata → suspend or warn → reply inside the deadline
- [ ] A runbook, so it happens the same way every time

## Step 14 — Error tracking — *you + code, ~half a day*

- [ ] Sentry on the API and on the frontend
- [ ] **Scrub before send.** No WireGuard key, session token, node token or
      Stripe secret may ever reach a third party.
- [ ] Verify the scrubber by triggering a deliberate error and reading what
      actually arrived in Sentry. Configuring it is not the same as it working.

## Step 15 — Alerts and uptime — *code, ~1 day*

Alert on things that need a human, not on things that are merely interesting:

| Alert | Threshold | Why it matters |
|---|---|---|
| A node stops reporting | no report for 2 min | Its customers are billed but may not be connected |
| Stripe webhook failures | any | Someone paid and got nothing |
| `wallet_minute_balance_non_negative` fires | ever | Sev-1 — something bypassed the service layer |
| Ledger sum ≠ wallet balance | nightly | The money is wrong |
| API 5xx rate | > 1% for 5 min | |
| Sessions ending `abandoned` | any spike | The agent or the node is broken |

- [ ] External uptime checks on the API, the web app, and **a real handshake
      through each node** — Better Stack or Uptime Kuma
- [ ] A status page, even a plain one

## Step 16 — Retention purge — *code, ~half a day*

The moment the privacy policy is published this becomes a legal commitment, and
there is no job today.

- [ ] A scheduled task in `backend/src/scheduler.ts` deleting operational
      metadata older than the window you chose in step 3
- [ ] **Keep the wallet ledger.** That is financial record-keeping — a different
      obligation with a longer retention period. Purge the *connection*
      metadata, not the money.
- [ ] Account deletion on request, and data export, if step 3 put you in GDPR
      scope
- [ ] Log what was purged and when, so compliance can be demonstrated rather
      than asserted

---

# Part E — Launch

## Step 17 — Beta, in stages — *you*

Do not skip stages. The credit model is the unvalidated hypothesis in this whole
product, and 25 real users will tell you more about it than any amount of
internal testing.

| Stage | Users | What you are actually measuring |
|---|---|---|
| Internal | 5 | Does a connection stay up for a week? |
| Private beta | 25 | Where does setup break, and does metered billing feel fair? |
| Paid beta | 100 | Will strangers pay? |
| Public | open | CAC, activation, repeat purchase |

Before the **paid** beta:

- [ ] All ten acceptance criteria in PRD §21 pass
- [ ] The restore drill from step 8 is done
- [ ] The runbooks from step 13d are written

---

## The five things most likely to go wrong

Ranked by impact × likelihood, with where each is handled:

1. **Stripe declines or delays underwriting.** Longest lead time — steps 4–6
   start on day one for this reason alone.
2. **Abuse gets you de-platformed by DigitalOcean.** Egress controls (step 10)
   and a fast abuse response (step 13d) from day one, not after the first
   complaint.
3. **The metered model does not resonate.** Cheapest of the five to test — that
   is what the private beta in step 17 is for.
4. **Magic links land in spam.** Kills activation silently, and you cannot fix
   it the day before launch. Step 2 exists for this.
5. **A billing bug leaks or over-charges minutes.** The database constraints and
   the regression suite exist for this. Keep CI green and never merge past a red
   `Backend tests` job.

---

## Quick reference — what is already done

So none of the above reads as "nothing works":

- Metered billing: minutes deducted only while a device carries real traffic,
  measured on the node, verified against a real WireGuard tunnel
- Atomic, idempotent wallet with an append-only ledger the application role
  cannot rewrite — enforced by database grants, not by convention
- Peer-set authorization: a zero balance removes the peer from the interface
  within one reconcile pass
- Passwordless auth with server-side sessions, hashed tokens, rate limiting
- Stripe checkout, signature verification, event de-duplication, refunds,
  disputes
- An outbound-only node agent with per-node bearer tokens and no inbound port
- CI running the regression suite, a real tunnel test and a browser test on
  every push
