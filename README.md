# TickVPN

Everything built so far for the TickVPN MVP, in one folder.

```
tickvpn-project/
├── frontend-mockup/     <- the visual mockup (landing page + dashboard)
│   └── index.html       <- open this file directly in a browser, no setup needed
│
└── backend/             <- the real API (wallet, usage engine, Stripe checkout)
    ├── src/
    ├── prisma/
    ├── setup.bat         <- Windows one-click setup
    └── README.md         <- backend-specific instructions
```

## What each piece is

- **`frontend-mockup/index.html`** — a static, click-through design of the landing page and
  customer dashboard. No install required. Double-click it and it opens in your browser.
  Nothing in it is "real" — no data is saved, no payments happen.

- **`backend/`** — an actual runnable Node.js + Postgres API implementing the wallet ledger,
  usage-window engine, and Stripe checkout from the PRD. See `backend/README.md` for how
  to run it.

These two are not connected to each other yet — the mockup is for design review, the
backend is for the real product logic. Wiring the two together (a real Next.js frontend
calling this API) is the next step once the design is approved.
