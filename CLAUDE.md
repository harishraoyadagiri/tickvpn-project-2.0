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

```bash
npm run dev               # server on :3001
npm run prisma:migrate    # apply migrations (never --name init again)
npm run seed              # products, regions, local node
npm test                  # vitest
npm run test:concurrency  # the 200-iteration parallel consume test
```

## Things that are deliberately not done yet

- Stripe underwriting, live keys, and the checkout redirect.
- Email delivery of magic links (tokens are logged in dev only).
- Terraform, real droplets, admin portal, monitoring.
