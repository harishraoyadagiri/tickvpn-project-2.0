# TickVPN

**Prepaid, metered-by-the-minute WireGuard VPN. No subscription, no auto-renewal.**

Buy VPN time, not months. A wallet holds **minutes**; a Day Pass is 1,440 of
them. Minutes are consumed only while a device is actually carrying traffic —
measured on the node, never in the browser. Disconnect and the meter stops.
Unused minutes stay in the wallet for the next trip.

---

## How a connection becomes money

This is the part worth understanding, because it is the whole product:

```
device carries traffic
  → node agent runs `wg show wg0 dump` every 10s
  → POST /api/internal/nodes/:id/report        (per-node bearer token)
  → qualifying?  handshake < 180s  AND  ≥ 5 MB moved since install
  → minutes debited from the wallet, one ledger row per tick
  → balance hits 0 → device leaves computeAllowedPeers()
  → agent GETs /peers every 15s and removes it from wg0
```

Two consequences fall out of that design:

- **You are charged for using the VPN, not for having it installed.** A phone
  that briefly wakes and completes one handshake costs nothing — the 5 MB
  threshold exists precisely so it doesn't.
- **A zero balance really does end the tunnel.** Authorization is peer-set
  membership, computed by one query. When you run out you leave the set, and
  the peer disappears from the interface. It is not a number in a dashboard
  that the network ignores.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for every layer.

---

## Repository layout

```
backend/          Node + TypeScript control plane (Express, Prisma, PostgreSQL)
  src/services/   Wallet, metering, authorization, provisioning, pricing
  src/routes/     Public API, node control plane, Stripe webhooks, dev helpers
  prisma/         Schema, migrations, and the least-privilege role script
  node-agent/     The Python agent that runs on each WireGuard droplet
  tests/          Regression suite, live-tunnel test, key validator

frontend/         Next.js 16 app — landing page, dashboard, devices, billing
  lib/wireguard   Client-side keypair generation; private keys never leave here
  tests/          Browser smoke test driven by Playwright

docs/             Architecture, roadmap, pricing model, product docs
.github/          CI: backend, tunnel, browser and frontend jobs
```

---

## Running it locally

Needs **Node 20+** and **PostgreSQL 16**.

**Windows, one command:** `cd backend && setup.bat` — brings up Postgres in
Docker, creates the role, migrates, seeds and starts the API.

**Everything else:**

```bash
# 1. database and the least-privilege application role
createdb tickvpn
psql "postgresql://postgres@localhost/tickvpn" \
  -v app_password=local-dev-password -v DBNAME=tickvpn \
  -f backend/prisma/sql/app_role.sql

# 2. backend
cd backend
cp .env.example .env          # point DATABASE_URL at tickvpn_app
npm install
npm run prisma:generate
npm run prisma:migrate
npm run seed
npm run dev                   # API on :3001

# 3. frontend, second terminal
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:3001" > .env.local
npm run dev                   # web on :3000
```

Open <http://localhost:3000> and sign in with any email. No mail is sent in
`console` mode — the sign-in token is printed in the API terminal and
pre-filled in the form.

> **The role step is not optional.** The app deliberately does not connect as a
> superuser: the ledger is append-only because the database refuses `UPDATE`
> and `DELETE` on it, not because the code promises not to. The API warns in
> development and refuses to start in production if it detects otherwise.

---

## Tests

| Command | Needs | What it proves |
|---|---|---|
| `npm --prefix backend test` | API running | 18 checks — auth, IDOR, ledger grants, unpaid Stripe sessions, rate limiting, metering, device caps |
| `npm --prefix backend run test:keys` | — | 500 real `wg genkey` keys accepted, junk rejected |
| `npm --prefix backend run test:tunnel` | a test tunnel | Real WireGuard: connect, bill, run out, get disconnected, top up, reconnect |
| `npm --prefix frontend run test:ui` | both running | Chromium drives login, the dashboard, all three regions, config generation |

The tunnel test needs a real interface, which a script builds for you:

```bash
sudo backend/tests/setup-local-wireguard.sh
npm --prefix backend run test:tunnel
sudo backend/tests/setup-local-wireguard.sh teardown
```

It needs Linux (network namespaces). On Windows, use WSL2 — or let CI run it,
which it does on every push.

---

## Status

The application works end to end. What is missing is a payment processor, a
domain, real servers, an admin portal and monitoring — none of it code you are
blocked on.

- **[`docs/GO-LIVE.md`](docs/GO-LIVE.md)** — the numbered, step-by-step list of
  everything left to do, with the exact commands and configuration values.
  Start here.
- **[`docs/ROADMAP.md`](docs/ROADMAP.md)** — the same work grouped into phases,
  with the reasoning behind the ordering and the ranked risks.

This is pre-launch software. It has never taken a real payment or carried a
real customer's traffic. Do not point strangers at it yet.

---

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) first — it is short, and it contains the
invariants that matter (the ledger is append-only; every balance change goes
through one function; authorization is one query). CI runs the regression suite
three times per push because the bugs that matter here are probabilistic.

## License

MIT — see [`LICENSE`](LICENSE).

## Security

Please report vulnerabilities privately. See [`SECURITY.md`](SECURITY.md).
