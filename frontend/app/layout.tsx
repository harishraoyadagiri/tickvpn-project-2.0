import type { Metadata } from "next";

/**
 * Font stacks, not next/font/google.
 *
 * next/font/google downloads typefaces at BUILD time, so a build behind a
 * proxy or on an air-gapped runner fails with a font error that looks nothing
 * like a network problem. These stacks render everywhere with no build-time
 * network call and no layout shift.
 *
 * To use the original typefaces, self-host them with next/font/local and put
 * the .woff2 files in the repo — that keeps the build hermetic. Going back to
 * next/font/google means CI needs outbound access to fonts.googleapis.com.
 */
const fontVars = {
  "--font-display":
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "--font-inter":
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "--font-mono":
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as React.CSSProperties;

import "./globals.css";

export const metadata: Metadata = {
  title: "TickVPN — Buy VPN time, not months.",
  description: "Prepaid, metered-by-the-minute WireGuard VPN. No subscription, no auto-renewal.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={fontVars}>
      <body>{children}</body>
    </html>
  );
}
