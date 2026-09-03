import Link from "next/link";
import { api, type PricingModel } from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { Logo } from "@/components/Logo";
import { PricingCurve } from "@/components/PricingCurve";

export const revalidate = 300; // pricing model rarely changes; no need to hit the API every request

export default async function LandingPage() {
  const pricing = await api.get<PricingModel>("/pricing/model").catch(
    () =>
      ({
        baseRate: 0.01958,
        decayExp: 0.62,
        minutesPerDayPass: 1440,
        tiers: [],
      }) as PricingModel
  );

  return (
    <div>
      <header>
        <div className="wrap">
          <Logo />
          <nav className="primary">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#trust">Privacy</a>
          </nav>
          <Link className="btn-ghost-sm" href="/login">
            Log in
          </Link>
        </div>
      </header>

      <section className="hero">
        <div className="wrap grid">
          <div>
            <div className="eyebrow">Prepaid · No subscription</div>
            <h1>
              Buy VPN time.
              <br />
              Not <span className="accent">months.</span>
            </h1>
            <p className="lead">
              A Tick Pass runs from 30 minutes to a full year, priced by one formula — the
              longer the pass, the lower the per-minute cost. It only drains while
              you&apos;re actually connected. Nothing charged while it sits unused.
            </p>
            <div className="hero-ctas">
              <Link className="btn btn-primary" href="/login">
                Get started — $0.19
              </Link>
              <a className="btn btn-outline" href="#pricing">
                See pricing
              </a>
            </div>
            <div className="trust-row">
              <div className="item">
                <CheckIcon /> No auto-renewal
              </div>
              <div className="item">
                <CheckIcon /> Credits never expire
              </div>
              <div className="item">
                <CheckIcon /> WireGuard under the hood
              </div>
            </div>
          </div>

          <div className="stack">
            <div className="ticket ghost2" />
            <div className="ticket ghost1" />
            <div className="ticket main-ticket">
              <div className="mt-row">
                <div>
                  <div className="mt-label">Tick Pass wallet</div>
                  <div className="mt-days">
                    180<span>min remaining</span>
                  </div>
                </div>
                <div className="status-pill">Ready</div>
              </div>
              <div className="perf mt-perf" />
              <div className="mt-fields">
                <div>
                  <div className="f-label">Region</div>
                  <div className="f-val">US · East</div>
                </div>
                <div>
                  <div className="f-label">Device</div>
                  <div className="f-val">MacBook Pro</div>
                </div>
                <div>
                  <div className="f-label">Protocol</div>
                  <div className="f-val">WireGuard</div>
                </div>
                <div>
                  <div className="f-label">Window</div>
                  <div className="f-val">Metered live</div>
                </div>
              </div>
              <div className="barcode mt-barcode" />
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="wrap">
          <div className="section-head">
            <h2>How it works</h2>
            <p>Closer to a transit fare card than a SaaS subscription.</p>
          </div>
          <div className="steps">
            <Step n="01" title="Buy a Tick Pass">
              Any duration from 30 minutes to a year. Pay once, no card kept on a billing cycle.
            </Step>
            <Step n="02" title="Pick a region">
              US, Europe, or Asia. Get a WireGuard config instantly.
            </Step>
            <Step n="03" title="Connect">
              Your pass meters minute-by-minute, only while you&apos;re actually connected.
            </Step>
            <Step n="04" title="Disconnect, no penalty">
              Disconnecting simply pauses the meter. Reconnect and it picks up right where it
              left off.
            </Step>
          </div>
        </div>
      </section>

      <section className="section" id="pricing">
        <div className="wrap">
          <div className="section-head">
            <h2>Pricing</h2>
            <p>One curve prices every tier — no hand-set discount table.</p>
          </div>
          <div className="curve-formula mono">
            price = ${pricing.baseRate} &times; minutes<sup>{pricing.decayExp}</sup>
          </div>
          <div className="curve-subtitle">The longer the pass, the cheaper every minute gets</div>
          {pricing.tiers.length > 0 && <PricingCurve tiers={pricing.tiers} />}
          <div className="tier-grid">
            {pricing.tiers.map((t) => {
              const rate = t.priceCents / t.minutes;
              return (
                <div key={t.name} className={`tier-card${t.minutes === 180 ? " anchor" : ""}`}>
                  <div className="tc-name">{t.name}</div>
                  <div className="tc-price">{formatPrice(t.priceCents)}</div>
                  <div className="tc-rate mono">
                    {rate < 1 ? (rate * 100).toFixed(2) + "¢/min" : formatPrice(rate) + "/min"}
                  </div>
                  <Link href="/login">
                    <button>Buy</button>
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section" id="trust">
        <div className="wrap">
          <div className="section-head">
            <h2>No subscription tricks</h2>
            <p>What you won&apos;t find here.</p>
          </div>
          <div className="feat-grid">
            <div className="feat">
              <h4>No monthly billing</h4>
              <p>Pay for a pass once. Nothing recurring, nothing to cancel.</p>
            </div>
            <div className="feat">
              <h4>No hidden auto-renew</h4>
              <p>Your wallet only goes down when you actually connect.</p>
            </div>
            <div className="feat">
              <h4>No browsing logs kept</h4>
              <p>We track connection timestamps and bandwidth totals — not destinations.</p>
            </div>
            <div className="feat">
              <h4>No forced upgrade</h4>
              <p>Same WireGuard access whether you bought 30 minutes or a year.</p>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="tagline">TickVPN — connectivity when you need it, nothing when you don&apos;t.</div>
          <div className="flinks">
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
            <a href="#">Support</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="step">
      <span className="num mono">{n}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M20 6L9 17l-5-5" stroke="#4FD1AE" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
