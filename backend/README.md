# TickVPN — backend

Node + Postgres control plane for metered VPN passes.

## The model, in one paragraph

A wallet holds **minutes**. A Day Pass is 1,440 of them. Minutes are consumed
only while a device is actually carrying traffic, measured on the node — not in
the browser, not by a timer that starts at purchase. Disconnect and the meter
stops; unused minutes stay in the wallet for the next trip. When the balance
reaches zero the device leaves the authorised peer set and the node drops the
peer within one reconcile pass, so a zero balance really does end the tunnel.

## How a connection becomes money

```
device carries traffic
  -> node agent: `wg show wg0 dump` every 10s
  -> POST /api/internal/nodes/:id/report      (per-node bearer token)
  -> qualifying?  handshake < 180s AND >= 5 MB moved since install
  -> minutes debited from the wallet, one ledger row per tick
  -> balance hits 0 -> device leaves computeAllowedPeers()
  -> agent GETs /peers every 15s and removes it from wg0
```

The agent is outbound-only and is the only writer to `wg0`.

## Running it locally

Needs Node 20+ and a Postgres 16.

```bash
# 1. database + least-privilege role (the ledger grant lives here)
createdb tickvpn
psql "$ADMIN_URL" -v app_password=choose-one -v DBNAME=tickvpn -f prisma/sql/app_role.sql

# 2. config
cp .env.example .env        # point DATABASE_URL at tickvpn_app

# 3. schema, client, data
npm install
npm run prisma:generate
npm run prisma:migrate
npm run seed

# 4. go
npm run dev                 # http://localhost:3001
```

The server refuses to start on invalid configuration rather than silently
disabling a security control, and prints the switches that change behaviour.

## Tests

```bash
npx ts-node tests/live-tunnel.ts   # full journey against a real WireGuard tunnel
npx ts-node tests/regressions.ts   # one test per audit finding
```

`live-tunnel.ts` needs a real `wg0` and a client in a network namespace; see the
header of that file. `regressions.ts` needs only the server and the database.

## Installing a node

```bash
# on the droplet, after WireGuard is up
sudo TICKVPN_API_URL=https://api.example.com \
     TICKVPN_NODE_ID=<node uuid> \
     TICKVPN_NODE_TOKEN=<minted token> \
     bash node-agent/install-agent.sh
```

Mint the token with `POST /dev/nodes/:nodeId/token` in development, or the admin
equivalent once that exists. It is shown once and stored only as a SHA-256 hash.

## What is deliberately not built yet

Stripe underwriting and live keys; email delivery of magic links (tokens are
logged in development only); Terraform; the admin portal; monitoring; the
retention purge job.
