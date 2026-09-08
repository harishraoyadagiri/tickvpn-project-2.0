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
npm test               # 18 regression checks — needs the server and database
npm run test:keys      # 500 real `wg genkey` keys through the validator
npm run test:tunnel    # full journey against a real WireGuard tunnel
```

`test:tunnel` needs a real `wg0` and a client in a network namespace. A script
builds both:

```bash
sudo tests/setup-local-wireguard.sh
npm run test:tunnel
sudo tests/setup-local-wireguard.sh teardown
```

It needs Linux. On Windows use WSL2, or let CI run it — it does, on every push.

## Installing a node

```bash
# copy the agent to the droplet, then run the installer there
scp -r backend/node-agent root@<droplet>:/opt/tickvpn-agent
ssh root@<droplet>

TICKVPN_API_URL=https://api.example.com \
TICKVPN_NODE_ID=<node uuid> \
TICKVPN_NODE_TOKEN=<minted token> \
  bash /opt/tickvpn-agent/install-agent.sh
```

The agent is outbound-only: it reports what WireGuard sees every 10s and pulls
the authorised peer set every 15s. It listens on nothing, so there is no port
to expose and no credential on the wire except to your own API over TLS.

Mint the token with `POST /dev/nodes/:nodeId/token` in development, or the admin
equivalent once that exists. It is shown once and stored only as a SHA-256 hash.

## What is deliberately not built yet

Stripe underwriting and live keys; Terraform; the admin portal; monitoring; the
retention purge job. All of it stepped out in
[`../docs/GO-LIVE.md`](../docs/GO-LIVE.md).

Magic-link delivery **is** built — `EMAIL_PROVIDER` selects `console` (prints
the link, sends nothing; refused in production), `resend`, or `smtp`. The link
carries the token in the URL **fragment**, so a corporate mail scanner that
follows links cannot burn it before the customer clicks.
