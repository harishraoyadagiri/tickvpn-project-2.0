import type { NextConfig } from "next";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const isDev = process.env.NODE_ENV !== "production";

/**
 * Security headers.
 *
 * The dashboard shows a wallet balance, a device list and a ledger, and has
 * one-click Revoke buttons — so framing protection is not decoration. A page
 * that can be put in an invisible iframe is a page whose buttons can be
 * clicked by someone else's site.
 *
 * The CSP is deliberately tight: no plugins, no framing, no base-tag
 * hijacking, and connections only to this app and its own API. Next.js needs
 * 'unsafe-inline' for styles, and in development it also needs 'unsafe-eval'
 * plus a websocket for hot reload — neither is allowed in a production build.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self'${isDev ? " 'unsafe-eval' 'unsafe-inline'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${API_URL}${isDev ? " ws: wss:" : ""}`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const nextConfig: NextConfig = {
  // Don't advertise the framework version to scanners.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          // Belt-and-braces alongside frame-ancestors, for older browsers.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Don't leak dashboard URLs (which carry ids) to third parties.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          // Only meaningful over HTTPS; harmless on localhost.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
