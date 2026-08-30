# Content Discovery Feature — Scope Doc

## Overview

Extends TickVPN from a pure utility into a content discovery surface — trending content by geo, plus top apps by geo, surfaced inside the app (and eventually pre-login). Goal: increase engagement per session and open a path to click-through revenue, without taking on paid data contracts or legal exposure in v1.

---

## V1 Scope (build now)

**In-app, logged-in only.** No pre-login access in v1 — that's a separate architecture lift (public caching, IP-geo detection, SEO exposure) and is deferred to v2 alongside multi-platform content.

### 1. Trending content: Netflix only

- **Source:** Netflix's official Top 10 (top10.netflix.com) — Netflix publishes this themselves, by country, split by films and TV.
- **Why this source:** Official, free, legitimate. Zero ToS risk. Refreshes weekly, which is genuinely "live" for a trending list.
- **Why Netflix-only for v1:** No other major platform (Disney+, Prime Video, etc.) publishes an equivalent official free feed. Adding them means falling back to unofficial scrapers or freemium third-party APIs (e.g. JustWatch) — real legal and reliability trade-offs. Not worth taking on until the core idea proves out.
- **Display logic:** Match trending list to the geo the user is currently connected through (not their home geo) — the entire value prop is "here's what's popular where you just connected to."

### 2. Top apps: iOS only

- **Source:** Apple's official App Store RSS feed for top free/paid apps, by country and category.
- **Why this source:** Official, free, sanctioned by Apple. Stable format, no scraping involved.
- **Why iOS-only for v1:** Google Play has no official free equivalent — only unofficial scrapers reading public pages not meant to be machine-read. That's a fragile foundation for a v1 launch. Defer Android to v2.

### 3. Placement

- Lives inside the existing content library concept (post-connect dashboard), matched to the connected geo.
- Not a separate page — an extension of the "what's trending here" section already scoped for the content library feature.

---

## V2 Scope (deferred, revisit after v1 engagement data)

### 1. Multi-platform content

- Add Disney+, Prime Video, and others once there's evidence the Netflix-only version is actually driving engagement.
- Will require a real build-vs-buy decision: unofficial scraper (ToS risk, fragile) vs. a freemium aggregator like JustWatch (cost, but legitimate and multi-platform out of the box). Worth a proper vendor eval at that point, not a default choice now.

### 2. Android app rankings

- Requires an unofficial scraper (e.g. `google-play-scraper`) against Play Store's public pages — no official free alternative exists.
- Treat as best-effort, not guaranteed-live: cache last-known-good data so a scraper breakage never shows a blank or stale-looking section to the user.
- Low practical legal risk at low read volume, but flag internally as unofficial before shipping.

### 3. Pre-login public discovery page

- Turns this from an in-app feature into a public-facing page — different problem entirely:
  - IP-based geo-detection (no account context to lean on)
  - CDN-cached, public API — can't hit the authenticated app backend per-visitor
  - Becomes an SEO/marketing surface once indexed — content freshness and quality matter more
  - Content licensing exposure is higher for a public page than an internal, logged-in feature — worth a light legal review before launch, not after
- Roughly doubles the scope of the feature versus the in-app version. Sequence after v1 proves engagement value, not before.

---

## Why this sequencing

V1 uses only official, free, zero-risk data sources — nothing here creates legal or reliability exposure before the idea is even validated. V2 items (multi-platform, Android rankings, pre-login) all trade off cost, legal risk, or engineering complexity for broader reach — worth paying for once there's real usage data justifying it, not before.
