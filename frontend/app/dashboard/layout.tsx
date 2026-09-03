"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Logo } from "@/components/Logo";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/useAuth";

const TABS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/devices", label: "Devices" },
  { href: "/dashboard/billing", label: "Billing" },
  { href: "/dashboard/discover", label: "Discover" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { loading } = useRequireAuth();

  async function logout() {
    await api.post("/auth/logout").catch(() => {});
    router.push("/");
  }

  if (loading) {
    return <div className="center-loading">Loading…</div>;
  }

  return (
    <div>
      <header>
        <div className="wrap">
          <Link href="/dashboard">
            <Logo />
          </Link>
          <nav className="primary">
            {TABS.map((t) => (
              <Link key={t.href} href={t.href} className={pathname === t.href ? "active" : ""}>
                {t.label}
              </Link>
            ))}
          </nav>
          <button className="btn-ghost-sm" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      <div className="wrap dash-shell">{children}</div>
    </div>
  );
}
