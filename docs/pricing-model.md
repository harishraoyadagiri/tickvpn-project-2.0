# TickVPN Pricing Model

## Summary

TickVPN bills on a per-minute base unit. Every pass — 30 minutes to annual — is priced off one formula, not a hand-set table. This means new tiers price themselves automatically; no manual repricing when we add or change a duration.

**Anchor decision:** 3-hour pass = **$0.49**. All other tiers are derived from this anchor using a power-curve decay function.

---

## Pricing Formula

```
price(m) = BASE_RATE × m^DECAY_EXP
```

- `BASE_RATE = 0.01958`
- `DECAY_EXP = 0.62`
- `m` = minutes granted

This is a power curve, not a flat discount table. Cost-per-minute drops smoothly as duration increases — no discontinuities, no reverse discounts, no per-tier hardcoding. Any new duration can be priced by plugging `m` into the formula.

---

## Pricing Table

| Tier | Minutes | Price | $/min |
|---|---|---|---|
| 30 min | 30 | $0.19 | $0.0063 |
| 60 min | 60 | $0.29 | $0.0048 |
| **3 hrs** | **180** | **$0.49** | **$0.0027** ← anchor |
| 6 hrs | 360 | $0.79 | $0.0022 |
| 12 hrs | 720 | $1.19 | $0.0017 |
| 24 hrs | 1,440 | $1.79 | $0.0012 |
| 1 week | 10,080 | $5.99 | $0.00059 |
| 15 days | 21,600 | $9.99 | $0.00046 |
| 30 days | 43,200 | $14.99 | $0.00035 |
| Annual | 525,600 | $69.99 | $0.00013 |

All passes include 3 concurrent device sessions.

---

## Market Positioning

**Research finding:** no competitor sells true metered, pay-per-minute VPN access. The "short-term" plans that exist (Hide.me's 60-day deal, VyprVPN promos) are still subscriptions dressed up as short-term — not metered. TickVPN isn't undercutting an existing category; it's defining one.

**Bottom-of-market subscription anchors used in this analysis:**
- Mullvad: $5.93/mo flat, no tiers
- VyprVPN: $6.47/mo (promo)
- Bitdefender: $6.99/mo
- Floor for "legit" cheap VPN subscriptions: ~$6/mo

Raw subscription-parity rate: $6/mo ÷ 43,200 min = $0.00014/min → a 3-hr pass at parity would be $0.025. Not a usable price point (too small to read as real, and would look broken at checkout). $0.49 sits ~20–30x above parity — real margin, still reads as functionally free next to any subscription.

### Where we win

- **30 min – 24 hr:** Uncontested. No competitor offers metered short-term access at any price. This is pure land-grab territory.
- **Annual ($69.99):** Beats every no-commitment, month-to-month competitor (those annualize to $108–$197/yr) while sitting above deep 2-year lock-in deals ($36–$46/yr). We're not the cheapest possible VPN — we're the cheapest VPN with zero lock-in.

### Where we intentionally don't compete

- **24 hr ($1.79)** looks expensive versus a subscription's implied day-rate (~$0.20–0.33/day) — but no one sells a real day pass. We're not competing on that math; we're competing on no signup, no card on file, no auto-renew.
- **30 day ($14.99)** runs ~2x the cheapest monthly subscription ($6–7). We are not trying to win "cheapest monthly VPN." We're winning "cheapest way to get VPN access with zero commitment." Different buyer.

---

## Admin Use Case: Pricing & Discount Management

Admins need a way to manage pricing and grant discounts without an engineering deploy. This sits on top of the same wallet-ledger model — no separate billing path.

**Core capabilities:**

1. **Edit tier pricing**
   - Admin can override `price(m)` per tier directly, or adjust `BASE_RATE` / `DECAY_EXP` to reprice the whole curve at once.
   - Per-tier overrides should be stored separately from the formula output, so a manual edit on one tier doesn't get silently overwritten if the curve constants change later.
   - Every price change is versioned and timestamped — need a clear audit trail of what price was live at what time, since this affects revenue reporting and any user disputes.

2. **Grant free minutes**
   - Admin credits `minutes_granted` directly to a user's wallet ledger, same entry type as a purchase but `price_paid = 0` and a `source: 'admin_grant'` tag.
   - Should support single-account grants and bulk grants (e.g., upload a list of account IDs, grant X minutes to all).
   - Needs a reason/note field on the grant — support credit, promo, bug compensation, etc. — for later reporting.

3. **Per-account discounts (fixed-minute or percentage)**
   - Admin can apply a discount rule scoped to one account: either a flat discount on a specific minute-bucket ("this account pays $X less for any pass up to 1,440 minutes") or a percentage off all purchases.
   - Discount rules need a start/end date (or "until removed") so promos don't run forever by accident.
   - At purchase time, the pricing function checks for an active account-level discount rule before charging — same formula, discount applied at the final price step, not baked into the curve.

**Data model addition:**

```
pricing_overrides:
  id, tier_minutes (nullable — null means "applies to formula constants"),
  override_price, base_rate, decay_exp,
  created_by, created_at, active

account_discounts:
  id, account_id, discount_type ('flat_minutes' | 'percentage'),
  discount_value, applies_to_minutes (nullable — null means all tiers),
  starts_at, ends_at, created_by, note

wallet_ledger (extended):
  ... existing fields ...
  source ('purchase' | 'admin_grant'), discount_applied, note
```

**Access control:** pricing edits and discount grants should be admin-role gated, with the audit log capturing who made each change — this is real revenue logic, not a cosmetic setting.

---

## Billing Mechanics (for reference)

- **Base unit:** minutes, tracked in a wallet ledger (`minutes_granted`, `minutes_remaining`)
- **Metering:** 30 min – 24 hr passes are true metered (balance decrements only while connected). Week/15-day/30-day/annual are hybrid — large minute grant capped by a calendar expiry.
- **Devices:** 3 concurrent sessions per active pass, not 3 devices total. 4th connection attempt is rejected.
- **Stacking:** passes queue — a new pass activates when the current one expires, not at purchase.
- **Payment economics:** because this is a wallet-debit model, per-pass transactions aren't constrained by card-processing fees — those apply only at wallet top-up. This is what makes sub-$1 pricing viable.
