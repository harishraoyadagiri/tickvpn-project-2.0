"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type LedgerEntry, type PricingModel, type Product } from "@/lib/api";
import { formatDateTime, formatPrice, humanDuration } from "@/lib/format";

export default function BillingPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [customMinutes, setCustomMinutes] = useState("");
  const [customEstimate, setCustomEstimate] = useState<string | null>(null);

  useEffect(() => {
    api.get<Product[]>("/products").then(setProducts).catch(() => setProducts([]));
    api
      .get<LedgerEntry[]>("/wallet/transactions")
      .then(setLedger)
      .catch(() => setLedger([]));
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
