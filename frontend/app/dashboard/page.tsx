"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type ConnectionStatus, type LedgerEntry } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

export default function DashboardPage() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .get<ConnectionStatus>("/vpn/status")
        .then((s) => !cancelled && setStatus(s))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 8000); // real status, polled — not billed by polling
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    api
      .get<LedgerEntry[]>("/wallet/transactions")
      .then(setLedger)
      .catch(() => setLedger([]));
  }, []);

  return (
    <div>
      <div className="dash-head">
        <div>
          <h1>Welcome back</h1>
          <div className="sub">Your Tick Pass balance and connection, at a glance.</div>
        </div>
        <Link className="btn btn-primary" href="/dashboard/billing">
          Buy more
        </Link>
      </div>

      <div className="dash-top">
        <div className="ticket balance-ticket">
          <div className="balance-left">
            <div className="f-label">Tick Pass minutes remaining</div>
            <div className="balance-num">
              {status ? status.minuteBalance.toLocaleString() : "—"}
              <span>min</span>
            </div>
          </div>
        </div>
        <div className="balance-ticket ticket" style={{ justifyContent: "center" }}>
          <div style={{ textAlign: "center", width: "100%" }}>
            <div style={{ fontSize: 11, color: "#8A93A6" }}>
              {status ? `${status.daysRemaining} day-equivalents left` : "loading…"}
            </div>
            <div className="barcode" style={{ marginTop: 10 }} />
          </div>
        </div>
      </div>

      <div className="conn-card">
        <div>
          <div className="conn-title">Connection · metered by the minute</div>
          <div className="conn-status">
            <div className={status?.connected ? "dot-live" : "dot-idle"} />
            <div className="region">{status?.connected ? "Connected" : "Not connected"}</div>
          </div>
          <div className="conn-sub">
            {status?.connected
              ? "Draining live, pauses the moment your WireGuard client disconnects."
              : "Import a device's config into a WireGuard client to connect for real."}
          </div>
        </div>
        <div>
          {status?.session ? (
            <>
              <div className="countdown mono">{status.session.minutesBilled} min billed</div>
              <div className="countdown-label">this session, since {formatDateTime(status.session.startedAt)}</div>
            </>
          ) : (
            <div className="countdown-label">No active session</div>
          )}
          <Link className="btn btn-outline btn-sm btn-block" style={{ marginTop: 10 }} href="/dashboard/devices">
            Manage devices
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Recent activity</h3>
          <Link className="link-btn" href="/dashboard/billing">
            View all in Billing
          </Link>
        </div>
        {ledger === null && <div style={{ color: "var(--muted)", fontSize: 13 }}>Loading…</div>}
        {ledger?.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No activity yet.</div>}
        {ledger?.slice(0, 5).map((row) => (
          <LedgerRow key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}

function LedgerRow({ row }: { row: LedgerEntry }) {
  const positive = row.amount > 0;
  return (
    <div className="ledger-row">
      <div>
        {describeType(row.type)}
        <span className="unit-tag minute">{row.unit}</span>
        <div className="ledger-type mono">
          {row.type} · {formatDateTime(row.createdAt)}
        </div>
      </div>
      <div className={`ledger-amt ${positive ? "pos" : "neg"}`}>
        {positive ? "+" : ""}
        {row.amount} min
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
