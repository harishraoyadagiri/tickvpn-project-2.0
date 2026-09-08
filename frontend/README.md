# TickVPN — web app

Next.js 16 (App Router). Landing page, passwordless login, and a four-page
dashboard. Client components throughout: the API is the source of truth, and
there is no server-side session to render from.

## Running it

Needs the API on `:3001` first — see the [root README](../README.md).

```bash
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:3001" > .env.local
npm run dev          # http://localhost:3000
```

`NEXT_PUBLIC_API_URL` is the only variable. In production it points at
`https://api.yourdomain.com`, and the same value must appear in the API's
`CORS_ALLOWED_ORIGINS` from the other direction.

## Layout

```
app/
  page.tsx              Landing page and pricing
  login/                Magic-link request and token entry
  dashboard/            Connect, devices, billing, discover
components/             Logo, pricing curve
lib/
  api.ts                Fetch wrapper — always credentialed
  wireguard.ts          Keypair generation, in the browser
  useAuth.ts            Probes GET /wallet; 401 redirects to /login
tests/ui-smoke.mjs      Playwright: login → region → config download
```

## Two things worth knowing before you change anything

**Private keys are generated here and never leave the browser.**
`lib/wireguard.ts` uses tweetnacl's Curve25519. Only the public key is sent to
the API; the private key goes into the `.conf` the customer downloads and into
this browser's local storage so the config can be shown again. Do not add an
endpoint that accepts one.

**The auth check is convenience, not security.** `useAuth` probing `/wallet` and
redirecting on 401 makes the UI behave; every route enforces its own
authorization server-side. Never treat a hidden button as a control.

## Fonts

System font stacks, set in `app/layout.tsx`. `next/font/google` was removed on
purpose — it downloads typefaces at build time, so any network restriction turns
into a confusing build failure. If you want a custom face, self-host it with
`next/font/local` and commit the file.

## Security headers

All of them live in `next.config.ts`, including the CSP. The comment there
explains why `script-src` allows `'unsafe-inline'` and what would have to change
to remove it. Read it before tightening the policy — a stricter value breaks
hydration silently, and only in a production build.

## Tests

```bash
npm run test:ui      # needs the API and the web app both running
```

Drives a real Chromium through login, the dashboard, all three regions and
config generation. It is the only test that catches a CORS or cookie
misconfiguration; the server-side suite once passed completely while the app was
unusable in a browser.
