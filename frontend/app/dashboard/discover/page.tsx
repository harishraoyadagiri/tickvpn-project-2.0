"use client";

import { useEffect, useState } from "react";
import { api, type TrendingPayload } from "@/lib/api";

const REGIONS = [
  { code: "us", label: "United States" },
  { code: "eu", label: "Europe" },
  { code: "asia", label: "Asia" },
];

export default function DiscoverPage() {
  const [region, setRegion] = useState("us");
  const [data, setData] = useState<TrendingPayload | null>(null);
  // Loading is derived rather than tracked separately: true whenever the
  // fetched payload isn't for the currently selected region yet.
  const loading = data === null || data.region !== region;

  useEffect(() => {
    let cancelled = false;
    api
      .get<TrendingPayload>(`/content/trending?region=${region}`)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
  }, [region]);

  return (
    <div>
      <div className="dash-head">
        <div>
          <h1>Discover</h1>
          <div className="sub">Trending Netflix titles and top iOS apps, by region.</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Region</h3>
        </div>
        <div className="region-pills">
          {REGIONS.map((r) => (
            <button
              key={r.code}
              className={`region-pill${region === r.code ? " active" : ""}`}
              onClick={() => setRegion(r.code)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="center-loading">Loading…</div>}

      {!loading && data && (
        <>
          <div className="discover-grid">
            <div className="card">
              <div className="card-head">
                <h3>Netflix · Movies</h3>
              </div>
              <ul className="discover-list">
                {data.netflixMovies.map((m) => (
                  <li className="discover-item" key={m.rank}>
                    <span className="discover-rank">#{m.rank}</span>
                    <span className="discover-title">{m.title}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <div className="card-head">
                <h3>Netflix · TV</h3>
              </div>
              <ul className="discover-list">
                {data.netflixTV.map((t) => (
                  <li className="discover-item" key={t.rank}>
                    <span className="discover-rank">#{t.rank}</span>
                    <span className="discover-title">{t.title}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <div className="card-head">
                <h3>Top Free Apps (iOS)</h3>
              </div>
              <ul className="discover-list">
                {data.apps.map((a) => (
                  <li className="discover-item" key={a.rank}>
                    <span className="discover-rank">#{a.rank}</span>
                    <span>
                      <span className="discover-title">{a.name}</span>
                      <br />
                      <span className="discover-artist">{a.artist}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className={`discover-note${data.netflixSource === "sample" || data.appsSource === "sample" ? " sample" : ""}`}>
            Netflix: {data.netflixSource} · Apps: {data.appsSource} · as of{" "}
            {new Date(data.asOf).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}
