"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Logo } from "@/components/Logo";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "token">("email");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [devToken, setDevToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ ok: true; devToken?: string }>("/auth/login", { email });
      setDevToken(res.devToken ?? null);
      if (res.devToken) setToken(res.devToken); // dev convenience: pre-fill so the form is one click
      setStep("token");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitToken(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/verify", { token });
      router.push("/dashboard");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Link href="/" style={{ display: "inline-block", marginBottom: 32 }}>
          <Logo />
        </Link>

        {step === "email" ? (
          <>
            <h1>Log in</h1>
            <p className="lead">
              No password — we&apos;ll send a one-time link to your email.
            </p>
            <form onSubmit={submitEmail}>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <button className="btn btn-primary btn-block" disabled={busy}>
                {busy ? <span className="spinner" /> : "Continue"}
              </button>
            </form>
            {error && <div className="form-msg error">{error}</div>}
          </>
        ) : (
          <>
            <h1>Check your email</h1>
            <p className="lead">
              We sent a sign-in link to <strong>{email}</strong>. Paste the token from that email
              below.
            </p>
            <form onSubmit={submitToken}>
              <div className="field">
                <label htmlFor="token">Sign-in token</label>
                <input
                  id="token"
                  required
                  autoFocus
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="paste your token"
                />
              </div>
              <button className="btn btn-primary btn-block" disabled={busy}>
                {busy ? <span className="spinner" /> : "Verify & continue"}
              </button>
            </form>
            {error && <div className="form-msg error">{error}</div>}
            {devToken && (
              <div className="form-msg muted" style={{ marginTop: 20 }}>
                Dev mode: no email provider is wired up yet, so the token is handed back directly
                (pre-filled above) instead of being emailed.
              </div>
            )}
            <button
              className="link-btn"
              style={{ marginTop: 16 }}
              onClick={() => {
                setStep("email");
                setError(null);
              }}
            >
              &larr; Use a different email
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "rate_limited") return "Too many attempts — try again in a bit.";
    if (err.code === "invalid_email") return "That doesn't look like a valid email.";
    if (err.code === "invalid_or_expired_token") return "That token is invalid or expired.";
    return err.code.replace(/_/g, " ");
  }
  return "Something went wrong — check that the backend is running.";
}
