# Security policy

## Reporting a vulnerability

Please report privately rather than opening a public issue.

- Use GitHub's **Report a vulnerability** button under the Security tab, or
- Email **harishraoyadagiri@gmail.com** with `SECURITY` in the subject

Include what you found, how to reproduce it, and what you think the impact is.
You will get an acknowledgement within a few days. Please give a reasonable
window to fix before disclosing publicly.

This is a pre-launch project run by a small team. There is no bounty, but
credit is offered gladly to anyone who wants it.

## What this project treats as security-critical

If you are looking for somewhere to poke, these are the places where a bug
actually costs something:

| Area | The invariant that must hold |
|---|---|
| `walletService.ts` | Every balance change is atomic, idempotent, and impossible to make negative. The database enforces the last part with a `CHECK` constraint. |
| The ledger | Append-only. The application database role has no `UPDATE` or `DELETE` grant on `WalletTransaction`. Corrections are new `REVERSAL` rows. |
| `authorizationService.ts` | One query decides who may carry traffic. A suspended user, a revoked device or a zero balance must all leave the peer set. |
| `meteringService.ts` | Time is never billed across a gap, byte counter resets are handled, and a stale handshake bills nothing however many bytes are reported. |
| Node control plane | Per-node bearer tokens, hashed and compared in constant time. A compromised node must not be able to speak for another node. |
| `routes/checkout.ts` | Only a signature-verified webhook grants entitlement. A completed checkout session that was never paid must credit nothing. |
| CORS and cookies | The allowlist is explicit. An arbitrary origin must never be reflected back alongside `Allow-Credentials`. |

## Design choices that are deliberate, not oversights

- **Client private keys never reach the server.** WireGuard keypairs are
  generated in the browser; only the public key is sent. The private key lives
  in that browser's local storage and in the config file the user downloads.
- **The node agent listens on nothing.** It makes only outbound calls, so there
  is no port to attack and no long-lived credential in flight except to the
  API over TLS.
- **We do not claim "no logs".** Operational metadata is retained for a bounded
  period so abuse complaints can be answered. What is kept, and for how long,
  is stated in the privacy policy.
- **Dev routes are gated twice.** They require an explicit `ENABLE_DEV_ROUTES`
  opt-in *and* a non-production `NODE_ENV`, and the server refuses to start if
  both are set wrongly. An unset variable never means "allow".
