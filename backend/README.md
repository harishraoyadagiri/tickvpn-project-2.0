# TickVPN — MVP Backend Scaffold

This is Sprint 2 + Sprint 3 from the PRD: **Commerce** and **Usage Engine**.
That's the core IP — atomic wallet, idempotent payments, exactly-one-credit-per-window.
Everything here is real, runnable code.

## What's real vs. stubbed

| Component | Status |
|---|---|
| Postgres schema (Prisma) | Real — matches PRD domain model exactly |
| Wallet ledger (atomic, idempotent) | Real |
| Usage window engine (24h, race-safe) | Real |
| Stripe checkout + webhook | Real — needs your live Stripe keys |
| Passwordless auth | Real for MVP (in-memory sessions — swap for Redis before prod) |
| VPN provisioning | **Mocked.** `MockNodeAdapter` in `provisioningService.ts` stands in for real DO droplets + WireGuard. Swap it for a `RealNodeAdapter` that SSHes into your nodes or calls a small agent running on each droplet — nothing else in the app changes. |
| Terraform / droplet setup | Not included — that's Sprint 1, needs your DO account |

## The two things that actually matter

1. **`walletService.ts`** — every balance change is atomic (row lock) and idempotent (unique key). This is what stops double-crediting on a Stripe webhook retry and stops a negative balance on concurrent usage.
2. **`usageService.ts`** — one VPN Day per 24h window, reconnects inside the window are free. There's also a partial unique index (`prisma/migrations_manual/001_one_active_window_per_user.sql`) as a DB-level backstop in case two devices connect in the same instant.

## Try it in your browser

Once `setup.bat` finishes (or `npm run dev` if running manually), open
**http://localhost:3001** in your browser. That's a small connected test
app — real API calls, not the design mockup. It lets you:

- Log in with any email (no real email is sent — this test build shows you
  the login token directly instead of emailing it)
- "Buy" test VPN Days without Stripe (`/dev/credit-wallet` — dev-only, blocked in production)
- Add a device and pick a region (calls the real, mock-backed provisioning service)
- Click **Connect now** and watch the balance actually drop by one day, a
  24-hour countdown start, and — if you click Connect again — watch it
  **not** charge you again, because you're still inside that window. That
  reconnect-is-free behavior is the core of the product; this is where you
  can see it work.
- Try connecting with zero balance and see it get correctly blocked

Sessions live in server memory, so restarting the server logs everyone out —
fine for local testing, not for production.

## Running it (Windows — one click)

Double-click **`setup.bat`**. It will:
1. Check for Node.js and Docker
2. Start a Postgres container (`vpndays-db`) if Docker is available
3. `npm install`
4. Create `.env` from the template (edit it first if your DB creds differ)
5. Generate Prisma client + run migrations
6. Seed products/regions/mock nodes
7. Start the dev server on `:3001`

After the first run, apply the manual partial-index migration once:
```
psql postgresql://postgres:password@localhost:5432/vpndays -f prisma/migrations_manual/001_one_active_window_per_user.sql
```
(or run it in any Postgres GUI client — pgAdmin, TablePlus, DBeaver).

## Running it (manual)

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
npm run prisma:generate
npm run prisma:migrate
npm run seed            # loads the 3 products + 3 regions + mock nodes from the PRD
npm run dev
```

Test the flow:
```bash
curl -X POST localhost:3001/auth/login -H "Content-Type: application/json" -d '{"email":"sk@test.com"}'
# grab the token from the console log, then:
curl -X POST localhost:3001/auth/verify -H "Content-Type: application/json" -d '{"token":"..."}'
curl localhost:3001/products
```

## Next step

When your DO droplets and WireGuard are live (Sprint 1), write `RealNodeAdapter`
implementing the same `VPNNodeAdapter` interface. That's the only file that
needs to change — wallet, usage engine, and every route stay exactly as-is.
