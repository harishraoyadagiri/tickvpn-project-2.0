"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type LedgerEntry, type PricingModel, type Product, type Purchase } from "@/lib/api";
import { formatDateTime, formatPrice, humanDuration } from "@/lib/format";

export default function BillingPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [customMinutes, setCustomMinutes] = useState("");
  const [customEstimate, setCustomEstimate] = useState<string | null>(null);
  const [ret, setRet] = useState<ReturnState>({ kind: "none" });

  useEffect(() => {
    api.get<Product[]>("/products").then(setProducts).catch(() => setProducts([]));
    api
      .get<LedgerEntry[]>("/wallet/transactions")
      .then(setLedger)
      .catch(() => setLedger([]));
  }, []);

  /**
   * Coming back from Stripe.
   *
   * Stripe redirects the moment the customer pays, but the minutes arrive
   * separately over the webhook — normally within a second, occasionally not.
   * Nothing here used to wait for that, so a successful payment looked exactly
   * like a failed one until the customer thought to refresh. During a payment,
   * "nothing happened" reads as "my money is gone".
   *
   * Read the query string from window.location rather than useSearchParams:
   * that hook opts the page out of static prerendering, and this is the only
   * place in the app that needs it.
   */
  useEffect(() => {
    let stop = false;

    async function resolveReturn() {
      const params = new URLSearchParams(window.location.search);
      const outcome = params.get("purchase");
      if (!outcome) return;

      // Clear it so a refresh doesn't replay the banner.
      window.history.replaceState({}, "", window.location.pathname);

      if (outcome === "cancelled") {
        setRet({ kind: "cancelled" });
        return;
      }

      const id = params.get("id");
      if (outcome !== "success" || !id) return;
      setRet({ kind: "crediting" });

      // ~20s of polling. Beyond that the honest answer is "not yet", not a
      // spinner that never resolves.
      for (let attempt = 0; attempt < 14 && !stop; attempt++) {
        try {
          const purchase = await api.get<Purchase>(`/purchases/${id}`);
          if (stop) return;
          if (purchase.status === "PAID") {
            setRet({ kind: "credited", purchase });
            api.get<LedgerEntry[]>("/wallet/transactions").then(setLedger).catch(() => {});
            return;
          }
          if (purchase.status === "FAILED" || purchase.status === "REFUNDED") {
            setRet({ kind: "failed", purchase });
            return;
          }
        } catch {
          // A transient error mid-poll is not a failed purchase. Keep trying.
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!stop) setRet({ kind: "slow" });
    }

    void resolveReturn();
    return () => {
      stop = true;
    };
  }, []);

  const customMinutesValid = Number.isInteger(Number(customMinutes)) && Number(customMinutes) >= 1;

  useEffect(() => {
    if (!customMinutesValid) return; // stale estimate is hidden at render time below, nothing to clear here
    const n = Number(customMinutes);
    const id = setTimeout(() => {
      api
        .get<PricingModel>(`/pricing/model?minutes=${n}`)
        .then((p) => setCustomEstimate(p.quoteCents !== undefined ? formatPrice(p.quoteCents) : null))
        .catch(() => setCustomEstimate(null));
    }, 250); // debounce — one request per pause in typing, not per keystroke
    return () => clearTimeout(id);
  }, [customMinutes, customMinutesValid]);

  async function buy(product: Product) {
    setBuying(product.id);
    setMsg(null);
    try {
      const res = await api.post<{ url: string }>("/checkout", { productId: product.id });
      // eslint-disable-next-line react-hooks/immutability -- browser navigation, not React state
      window.location.href = res.url;
    } catch (err) {
      if (err instanceof ApiError && err.code === "payments_not_configured") {
        setMsg({
          text: "Payments aren't configured yet — add STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET to the backend .env to enable real purchases.",
          error: true,
        });
      } else {
        setMsg({ text: "Checkout failed to start.", error: true });
      }
    } finally {
      setBuying(null);
    }
  }

  return (
    <div>
      <div className="dash-head">
        <div>
          <h1>Billing</h1>
          <div className="sub">Buy a Tick Pass and review your full ledger.</div>
        </div>
      </div>

      {ret.kind !== "none" && (
        <div className={`purchase-banner ${bannerTone(ret.kind)}`} role="status" aria-live="polite">
          <div className="pb-body">
            {ret.kind === "crediting" && (
              <>
                <span className="spinner" />
                <span>Payment received. Adding the minutes to your wallet&hellip;</span>
              </>
            )}
            {ret.kind === "credited" && (
              <span>
                <strong>{ret.purchase.minutes} minutes added.</strong> {ret.purchase.productName} is in
                your wallet and your ledger below.
              </span>
            )}
            {ret.kind === "slow" && (
              <span>
                Stripe has your payment, but the credit hasn&rsquo;t landed yet. It arrives over a
                webhook and is normally instant &mdash; give it a moment and refresh. Nothing is lost.
              </span>
            )}
            {ret.kind === "failed" && (
              <span>
                That payment ended as <strong>{ret.purchase.status.toLowerCase()}</strong>. No minutes
                were added.
              </span>
            )}
            {ret.kind === "cancelled" && <span>Checkout cancelled &mdash; you weren&rsquo;t charged.</span>}
          </div>
          <button className="pb-dismiss" onClick={() => setRet({ kind: "none" })} aria-label="Dismiss">
            &times;
          </button>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>
            Buy a Tick Pass <span className="unit-tag minute">MINUTE</span>
          </h3>
          <span className="link-btn">Priced by the formula</span>
        </div>
        <div className="buy-grid">
          {products?.map((p) => {
            const rate = p.priceCents / p.durationMinutes;
            return (
              <div key={p.id} className={`buy-pill${p.durationMinutes === 180 ? " anchor" : ""}`}>
                <div className="bp-amt">{humanDuration(p.durationMinutes)}</div>
                <div className="bp-price">{formatPrice(p.priceCents)}</div>
                <div className="bp-rate mono">{rate.toFixed(3)}¢/min</div>
                <button onClick={() => buy(p)} disabled={buying === p.id}>
                  {buying === p.id ? <span className="spinner" /> : "Buy"}
                </button>
              </div>
            );
          })}
          {products === null && <div style={{ color: "var(--muted)", fontSize: 13 }}>Loading…</div>}
        </div>
        <div className="custom-buy-row">
          <label htmlFor="custom-minutes">Custom amount</label>
          <input
            id="custom-minutes"
            type="number"
            min={1}
            step={1}
            placeholder="e.g. 90"
            value={customMinutes}
            onChange={(e) => setCustomMinutes(e.target.value)}
          />
          <div className="est-price">
            {customMinutesValid && customEstimate
              ? `≈ ${customEstimate} for ${customMinutes} minutes`
              : "minutes — priced live by the formula"}
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8 }}>
          Custom amounts are a live price estimate only — checkout currently ships fixed passes
          above (the backend has no arbitrary-amount checkout endpoint yet).
        </div>
        {msg && <div className={`buy-msg${msg.error ? " error" : ""}`}>{msg.text}</div>}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Full ledger</h3>
          <span className="link-btn">{ledger?.length ?? 0} transactions</span>
        </div>
        {ledger === null && <div style={{ color: "var(--muted)", fontSize: 13 }}>Loading…</div>}
        {ledger?.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No transactions yet.</div>}
        {ledger?.map((row) => (
          <div className="ledger-row" key={row.id}>
            <div>
              {describeType(row.type)}
              <span className="unit-tag minute">{row.unit}</span>
              <div className="ledger-type mono">
                {row.type} · {formatDateTime(row.createdAt)}
              </div>
            </div>
            <div className={`ledger-amt ${row.amount > 0 ? "pos" : "neg"}`}>
              {row.amount > 0 ? "+" : ""}
              {row.amount} min
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type ReturnState =
  | { kind: "none" }
  | { kind: "cancelled" }
  | { kind: "crediting" }
  | { kind: "slow" }
  | { kind: "credited"; purchase: Purchase }
  | { kind: "failed"; purchase: Purchase };

function bannerTone(kind: ReturnState["kind"]): string {
  if (kind === "credited") return "ok";
  if (kind === "failed") return "bad";
  return "neutral";
}

function describeType(type: string): string {
  switch (type) {
    case "USAGE":
      return "Tick Pass connected";
    case "PURCHASE":
      return "Tick Pass purchased";
    case "PROMOTIONAL":
      return "Promotional credit";
    case "REVERSAL":
      return "Reversal";
    default:
      return type;
  }
}
