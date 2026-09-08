# TickVPN — working agreement

Read this before changing anything. These are invariants, not preferences.

## Domain model in one paragraph

A wallet holds **minutes**. That is the only currency. A "Day Pass" is 1,440
minutes; a "3 Hour Pass" is 180. Minutes are consumed **only while a device is
actually carrying VPN traffic**, measured on the node, never in the browser.
Unused minutes stay in the wallet for the next trip. Every balance change is a
row in an append-only ledger.

## Invariants

- `WalletTransaction` is append-only. Never UPDATE, never DELETE. Corrections
  are new `REVERSAL` rows. The application database role has no UPDATE or
  DELETE grant on that table — if you find yourself needing one, you are
  solving the wrong problem.
- Every balance change goes through `walletService.applyWalletTransaction*`.
  No route, webhook, service or admin action touches `Wallet.minuteBalance`
  directly.
- Every wallet mutation carries a **stable, meaningful** idempotency key. Never
  key on wall-clock time — key on the entity the change belongs to (a session
  id, a Stripe event id, a purchase id).
- `Wallet.minuteBalance` can never go negative. The database enforces this with
  a CHECK constraint. If that constraint ever fires, it is a Sev-1: something
  bypassed the service layer.
- Authorization to use the VPN is expressed as **peer-set membership**, computed
  in `authorizationService.computeAllowedPeers`. There is exactly one query that
  decides who may connect. Do not add a second one.
- The node agent is the only writer to `wg0`. Nothing else touches peers.
- Never log WireGuard private keys, session tokens, node agent tokens, or Stripe
  secrets. Client private keys must never reach the server at all.

## Rules for new code

- Every route handler is wrapped in `asyncRoute()`. An unwrapped `async` handler
  in Express 4 swallows rejections and hangs the request forever.
- Every route that takes an `:id` must scope the lookup by `req.userId`. Every
  new route needs an authorization test for anonymous, wrong-user and suspended-user.
- Configuration is read from `src/lib/env.ts` only. Never `process.env.X` inline.
  Anything security-relevant fails **closed** when unset.
- Anything that talks to a node or a third party has a timeout.

## Commands

Run these from `backend/`:

```bash
npm run dev               # API on :3001
npm run prisma:migrate    # apply migrations (never --name init again)
npm run seed              # products, regions, local node
npm test                  # 18 regression checks — needs the API and database up
npm run test:keys         # 500 real `wg genkey` keys through the validator
npm run test:tunnel       # the full journey against a real WireGuard tunnel
npm run typecheck
```

From `frontend/`:

```bash
npm run dev               # web on :3000
npm run test:ui           # Playwright — needs both the API and the web app up
```

CI runs the regression suite **three times** per push. That is deliberate: the
bugs that matter here are probabilistic, and the key-validator bug that shipped
to `main` was invisible on a single run and only appeared on the fifth.

## Things that are deliberately not done yet

- Stripe underwriting and live keys (the code path, webhook handling and
  de-duplication are all built and tested).
- Terraform, real droplets, the admin portal, monitoring, the retention purge.

Everything left is stepped out in [`docs/GO-LIVE.md`](docs/GO-LIVE.md), with the
reasoning behind the ordering in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Two traps that have already cost time

- **Do not use `next/font/google`.** It downloads typefaces at build time, so
  any network restriction turns into a confusing build failure. System stacks
  are set in `frontend/app/layout.tsx`; use `next/font/local` if you need a
  custom face.
- **Do not tighten `script-src` in `frontend/next.config.ts` without reading the
  comment above it.** Removing `'unsafe-inline'` breaks React hydration
  silently, and only in a production build — every button stops working and
  nothing in the UI says why.
