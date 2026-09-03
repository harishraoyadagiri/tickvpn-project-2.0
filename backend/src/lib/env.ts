import "dotenv/config";

/**
 * Single source of configuration. Nothing else in the app reads process.env.
 *
 * The rule here is that anything security-relevant fails CLOSED. An unset
 * variable must never mean "allow" — that is how the node callback used to be
 * bypassable and how the dev routes could have shipped live.
 */

class ConfigError extends Error {}

const problems: string[] = [];

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    problems.push(`${name} is required but not set`);
    return "";
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    problems.push(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return n;
}

const NODE_ENV = optional("NODE_ENV", "development");
const isProduction = NODE_ENV === "production";

/** Dev-only endpoints require an explicit opt-in AND a non-production env. */
const devRoutesRequested = optional("ENABLE_DEV_ROUTES", "false") === "true";

export const env = {
  NODE_ENV,
  isProduction,
  isTest: NODE_ENV === "test",
  isDevelopment: NODE_ENV === "development",

  DATABASE_URL: required("DATABASE_URL"),
  PORT: integer("PORT", 3001),
  APP_URL: optional("APP_URL", "http://localhost:3001"),

  /** Dev/test endpoints that mint balance. Never reachable in production. */
  enableDevRoutes: devRoutesRequested && !isProduction,

  /** Real WireGuard nodes vs. the in-process mock adapter. */
  useRealNodes: optional("USE_REAL_NODES", "false") === "true",

  /** Stripe is optional until underwriting is done; required once in production. */
  STRIPE_SECRET_KEY: isProduction ? required("STRIPE_SECRET_KEY") : optional("STRIPE_SECRET_KEY", ""),
  STRIPE_WEBHOOK_SECRET: isProduction ? required("STRIPE_WEBHOOK_SECRET") : optional("STRIPE_WEBHOOK_SECRET", ""),

  /** Qualifying-usage classifier (Technical Decisions D2). */
  QUALIFYING_BYTES: integer("QUALIFYING_BYTES", 5 * 1024 * 1024),
  HANDSHAKE_FRESH_SECONDS: integer("HANDSHAKE_FRESH_SECONDS", 180),

  /** Product policy. */
  MAX_DEVICES_PER_USER: integer("MAX_DEVICES_PER_USER", 3),
  MINUTES_PER_DAY_PASS: integer("MINUTES_PER_DAY_PASS", 1440),

  /** Auth. */
  LOGIN_TOKEN_TTL_MINUTES: integer("LOGIN_TOKEN_TTL_MINUTES", 10),
  SESSION_TTL_HOURS: integer("SESSION_TTL_HOURS", 24 * 30),
  LOGIN_RATE_LIMIT_PER_HOUR: integer("LOGIN_RATE_LIMIT_PER_HOUR", 5),

  /** Outbound calls to node agents. */
  NODE_AGENT_PORT: integer("NODE_AGENT_PORT", 8787),
  NODE_AGENT_TIMEOUT_MS: integer("NODE_AGENT_TIMEOUT_MS", 5000),

  /** Cookies. Secure must be on anywhere that isn't plain-http local dev. */
  COOKIE_SECURE: optional("COOKIE_SECURE", isProduction ? "true" : "false") === "true",
};

/**
 * Call once at boot, before listen(). Throws rather than starting in a state
 * where a missing variable silently disables a security control.
 */
export function assertConfigValid(): void {
  if (devRoutesRequested && isProduction) {
    problems.push("ENABLE_DEV_ROUTES cannot be true when NODE_ENV=production");
  }
  if (isProduction && !env.COOKIE_SECURE) {
    problems.push("COOKIE_SECURE must be true in production");
  }
  if (problems.length > 0) {
    throw new ConfigError(
      "Refusing to start — configuration is invalid:\n" +
        problems.map((p) => `  * ${p}`).join("\n") +
        "\n\nCopy .env.example to .env and fill it in."
    );
  }
}

/** Safe to log: no secrets, just the switches that change behaviour. */
export function configSummary() {
  return {
    NODE_ENV: env.NODE_ENV,
    port: env.PORT,
    devRoutes: env.enableDevRoutes ? "ENABLED" : "disabled",
    nodes: env.useRealNodes ? "real" : "mock",
    stripe: env.STRIPE_SECRET_KEY ? "configured" : "not configured",
    qualifyingBytes: env.QUALIFYING_BYTES,
    handshakeFreshSeconds: env.HANDSHAKE_FRESH_SECONDS,
  };
}
