"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Wallet } from "@/lib/api";

/**
 * There's no dedicated "who am I" endpoint on the backend, so this probes
 * with GET /wallet (every dashboard page needs the balance anyway) and
 * treats a 401 as "not logged in". Redirects to /login when unauthenticated.
 */
export function useRequireAuth() {
  const router = useRouter();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Wallet>("/wallet")
      .then((w) => {
        if (!cancelled) {
          setWallet(w);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
          return;
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return { wallet, loading, refreshWallet: () => api.get<Wallet>("/wallet").then(setWallet) };
}
