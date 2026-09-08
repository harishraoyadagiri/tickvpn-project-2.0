# Archive

Kept for provenance, not for use.

- **`design-mockup.html`** — the original static click-through mockup of the
  landing page and dashboard. It was never wired to the API and is superseded
  by the real Next.js app in `frontend/`. Useful only as a record of the
  original visual direction.

The backend also used to serve a single-file test app from `backend/public/`.
It was removed rather than archived: it called `/vpn/test-connect-timed` and
`/vpn/test-disconnect-timed`, endpoints that no longer exist, so it had been
silently broken since the metering rewrite. Shipping a broken UI on the API's
own origin is worse than shipping none.
