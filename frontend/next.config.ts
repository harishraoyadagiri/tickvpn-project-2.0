import type { NextConfig } from "next";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const isDev = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy.
 *
 * `script-src` allows 'unsafe-inline', and that is a deliberate decision
 * rather than an oversight. Next.js emits an inline bootstrap script to
 * hydrate the page. Blocking it does not degrade the site — it breaks it
 * completely and silently: React never hydrates, every button stops working,
 * and nothing appears in the UI to say why. It only shows up in a production
 * build, never in `next dev`.
 *
 * The correct fix is a per-request nonce from middleware. That was tried and
 * removed: a nonce cannot match the inline script inside a statically
 * prerendered page, because that HTML was generated at build time. Making it
 * work means forcing every page to render dynamically, which is a real cost
 * for an app that has no HTML-injection surface at all — nothing here renders
 * user-supplied markup, there is no dangerouslySetInnerHTML anywhere, and
 * React escapes everything else.
 *
 * The directives that actually defend this app are all still strict:
 *   frame-ancestors 'none'   the dashboard has one-click Revoke buttons
 *   connect-src              exfiltration can only target our own API
 *   object-src 'none'        no plugins
 *   base-uri 'self'          no <base> hijacking of relative script URLs
 *   form-action 'self'       no posting credentials to someone else's server
 *
 * If a feature ever renders user-supplied HTML, revisit this: force dynamic
 * rendering and switch to a nonce before that feature ships.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
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
