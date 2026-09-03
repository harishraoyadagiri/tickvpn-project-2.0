import { tierShortLabel } from "@/lib/format";
import type { PricingModel } from "@/lib/api";

/**
 * Bar chart of cost PER MINUTE, one bar per tier, falling as pass duration
 * grows. Log-scaled bar heights (rates span ~50x) with a small minimum floor
 * so the cheapest (Annual) bar never disappears to nothing.
 */
export function PricingCurve({ tiers }: { tiers: PricingModel["tiers"] }) {
  const W = 1000,
    H = 340,
    L = 46,
    R = 20,
    T = 34,
    B = 54;
  const plotW = W - L - R,
    plotH = H - T - B;
  const n = tiers.length;
  const gap = 10;
  const barW = (plotW - gap * (n - 1)) / n;
  const rates = tiers.map((t) => t.priceCents / t.minutes);
  const logRates = rates.map((r) => Math.log10(r));
  const logMax = logRates[0],
    logMin = logRates[logRates.length - 1];
  const BASE_H = 8;
  const barHeight = (logR: number) => {
    const norm = logMax === logMin ? 1 : (logR - logMin) / (logMax - logMin);
    return BASE_H + (plotH - BASE_H) * norm;
  };

  return (
    <div className="curve-wrap">
      <div className="curve-ylabel">¢ / minute</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="curve-svg">
        <line x1={L} y1={T + plotH} x2={L + plotW} y2={T + plotH} className="curve-axis" />
        {tiers.map((t, i) => {
          const rate = rates[i];
          const h = barHeight(logRates[i]);
          const x = L + i * (barW + gap);
          const y = T + plotH - h;
          const cx = x + barW / 2;
          const isAnchor = t.minutes === 180;
          return (
            <g key={t.name}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={4}
                className={`curve-bar${isAnchor ? " anchor" : ""}`}
              />
              <text x={cx} y={y - 8} textAnchor="middle" className="curve-label">
                {rate.toFixed(3)}¢
              </text>
              <text x={cx} y={T + plotH + 18} textAnchor="middle" className="curve-label dim">
                {tierShortLabel(t.minutes)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
