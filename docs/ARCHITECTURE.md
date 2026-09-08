# Architecture

Every layer, and what is actually true about each one.

---

## The shape of it

```
                    ┌──────────────────────────────────────────┐
  CLIENT            │ Browser (Next.js)   WireGuard client app  │
                    │ session cookie      installs a .conf      │
                    └────────┬─────────────────────────────────┘
                             │ HTTPS, credentialed fetch
                             ▼
                    ┌──────────────────────────────────────────┐
  EDGE              │ helmet · CORS allowlist · JSON limit      │
                    │ Stripe webhook mounted BEFORE json()      │
                    └────────┬─────────────────────────────────┘
                             ▼
                    ┌──────────────────────────────────────────┐
  AUTH              │ magic link (hashed) → server-side session │
                    │ requireAuth also rejects suspended users  │
                    └────────┬─────────────────────────────────┘
                             ▼
    ┌────────────────────────┴───────────────────────────────────┐
    │ DOMAIN SERVICES                                            │
    │  wallet · metering · authorization · provisioning ·        │
    │  pricing · rate limiting · content discovery               │
    └────────────────────────┬───────────────────────────────────┘
                             ▼
                    ┌──────────────────────────────────────────┐
  DATA              │ PostgreSQL, via the tickvpn_app role      │
                    │ CHECK(balance>=0) · no UPDATE/DELETE on   │
                    │ the ledger · 2 partial unique indexes     │
                    └──────────────────────────────────────────┘
                             ▲
                             │ per-node bearer token, outbound only
                    ┌────────┴─────────────────────────────────┐
  VPN PLANE         │ node agent → wg0 peers on the droplet    │
                    │ report every 10s · reconcile every 15s   │
                    └──────────────────────────────────────────┘
```

---

## Client

The browser holds an httpOnly session cookie and nothing else of value.

**WireGuard keypairs are generated in the browser** (`frontend/lib/wireguard.ts`,
using tweetnacl's Curve25519). Only the public key is sent to the API. The
private key is written into the `.conf` the customer downloads and kept in that
browser's local storage so the config can be shown again later; it never
touches a server.

tweetnacl's raw secret is not stored in WireGuard's "clamped" form, which looks
alarming and is fine: both `wg pubkey` and tweetnacl clamp during scalar
multiplication, so they derive the identical public key. Verified against real
`wg` over 200 keypairs — `backend/tests/keycheck.ts` guards the format
validator that goes with it.

---

## Frontend

Next.js 16 App Router, four authenticated pages plus a landing page and login.
Client components throughout — the API is the source of truth and there is no
server-side session to render from.

Auth is probed with `GET /wallet`; a 401 redirects to `/login`. That is
convenience, not security: every route enforces its own authorization
server-side.

Security headers are set in `next.config.ts`: a CSP with `frame-ancestors
'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS, and
`poweredByHeader: false`. The dashboard has one-click **Revoke** buttons, so
framing protection is not decoration.

Fonts are system stacks rather than `next/font/google`, which downloads at
build time and turns any network restriction into a confusing build failure.

---

## Edge

`backend/src/server.ts`, in this order, and the order matters:

1. **`assertConfigValid()`** before anything opens a socket. Invalid config is a
   refusal to start, not a warning — that is how a missing variable used to
   silently disable a security control.
2. **helmet**, with CSP off (this is a JSON API; the CSP that matters is the
   frontend's).
3. **CORS**, an explicit allowlist. Unknown origins get no `Allow-Origin`
   header at all. Reflecting an arbitrary origin alongside `Allow-Credentials`
   would let any website read a logged-in customer's wallet, devices and ledger.
4. **The Stripe webhook**, mounted *before* `express.json()` because signature
   verification needs the raw body.
5. `express.json({ limit: "100kb" })`, cookies, then the routers.
6. **The error handler last.** Every handler is wrapped in `asyncRoute()`;
   Express 4 does not catch rejected promises from async handlers, and an
   unwrapped one leaves the request hanging forever with no log line.

---

## Auth

Passwordless. `POST /auth/login` rate-limits by IP **and** by email, creates the
user if needed, and mails a single-use token. Only the SHA-256 of that token is
stored. `POST /auth/verify` marks it used and creates the session in one
transaction, so single-use survives two tabs racing.

Sessions live in Postgres, not process memory: a restart no longer logs everyone
out, a session can be revoked, and the store cannot grow without bound. The
cookie carries a random secret; the database stores only its hash.

`requireAuth` rejects suspended accounts, so suspension takes effect everywhere
at once rather than route by route.

The magic link points at the app with the token in the **fragment**, not at a
GET endpoint that consumes it — corporate mail scanners follow links, and a GET
that verified the token would let a scanner burn it before the customer clicked.

---

## Domain services

| Service | Responsibility |
|---|---|
| `walletService` | The only thing that changes a balance. Row lock, mandatory idempotency key, signed amounts, optional clamp-at-zero. |
| `meteringService` | Turns node reports into minutes. Qualifying-usage classifier, counter-reset handling, never bills across a gap. |
| `authorizationService` | **One query** decides who may carry traffic. Do not add a second. |
| `provisioningService` | Node selection by live capacity, per-node address allocation with reuse, device caps, key validation. |
| `pricingService` | One power curve, ten named tiers. Anchored at the 3-hour pass. |
| `rateLimitService` | Postgres-backed counters — one fewer vendor than Redis at this scale, and it survives a restart. |
| `contentDiscoveryService` | Apple's official RSS and Netflix's published Top 10, cached, with labelled sample fallback. |

### The wallet

Minutes are the only currency. Every mutation carries a **stable, meaningful**
idempotency key derived from the entity it belongs to — a session id, a Stripe
event id, a purchase id. Never wall-clock time: an hour-granular key silently
returns someone else's transaction and skips the balance check entirely.

### The metering rules

Three, all load-bearing:

1. **Qualifying usage** = handshake fresh (< 180s) **and** ≥ 5 MB moved since
   the peer was installed. A phone waking on a lock screen must not cost money.
2. **Counter resets are normal.** Removing and re-adding a peer zeroes its byte
   counters, and the reconcile loop does that routinely. A counter going
   backwards means a reset: count the new value as the delta.
3. **Never bill across a gap.** A peer that went quiet and came back an hour
   later closes the old session at its last billed minute and opens a new one.

One ACTIVE session per user, enforced by a partial unique index. Two devices
connected at once is still one clock, so it costs one stream of minutes.

---

## Data

PostgreSQL 16 via Prisma with the `pg` driver adapter and the query compiler —
no Rust engine binary, so installs and CI never download a platform-specific
40 MB blob from a CDN.

The application connects as **`tickvpn_app`**, not a superuser. That is the
whole point:

| Guarantee | Enforced by |
|---|---|
| Balance can never go negative | `CHECK (minuteBalance >= 0)` |
| The ledger is append-only | `REVOKE UPDATE, DELETE ON "WalletTransaction"` |
| Every ledger row has an idempotency key | `NOT NULL` + `UNIQUE` |
| One active usage window per user | partial unique index |
| One active metered session per user | partial unique index |
| One tunnel address per node | `UNIQUE (nodeId, internalIp)` |

`prisma/sql/app_role.sql` creates the role. The API checks at boot and refuses
to start in production if it finds itself holding rights it should not have.

---

## VPN plane

Each droplet runs `node-agent/agent.py` under systemd. Two loops, from
Technical Decisions D2:

- **Report, every 10s** — `wg show wg0 dump` → `POST /api/internal/nodes/:id/report`
- **Reconcile, every 15s** — `GET .../peers` → make `wg0` match exactly

The agent is **outbound only**. It listens on nothing, so there is no port to
firewall and no long-lived credential in flight except to the API over TLS. It
is also the only writer to `wg0`; nothing else touches peers.

Authentication is a per-node bearer token, stored only as a SHA-256 hash and
compared in constant time. A compromised node can speak for itself and no other.

Client configs are issued **without** `PersistentKeepalive`. Keepalive
manufactures handshakes with no user traffic, which would make handshake
freshness useless as a signal for "is this peer actually in use".

The trade-off is up to ~15 seconds between authorization changing and the node
agreeing. D2 accepted that in the other direction; it applies both ways.

---

## Data collection

What is written, and by whom:

| Data | Written by | Purpose |
|---|---|---|
| `Device.rxBytes/txBytes/cumulativeBytes` | the report loop only | Qualifying-usage classifier |
| `Device.lastHandshakeAt` | the report loop only | Freshness, and "last connected" in the UI |
| `TimeSession.minutesBilled/bytesUsed` | metering | Billing and support |
| `WalletTransaction` | `walletService` only | Financial record |
| `RateLimitHit` | login attempts | Abuse control; swept hourly |

Never collected: DNS queries, destination IPs, packet contents, browsing
history. The node's resolver does not log.

Retention is a decision that has not been made yet, and the purge job does not
exist. Both are Phase 0.3 and 5.4 in [`ROADMAP.md`](ROADMAP.md), and the privacy
policy cannot be written before the first.

---

## What is deliberately not here

Admin portal, monitoring and alerting, the retention purge, Terraform, and
Stripe underwriting. Sequenced with reasoning in [`ROADMAP.md`](ROADMAP.md), and
as a numbered checklist with commands in [`GO-LIVE.md`](GO-LIVE.md).
