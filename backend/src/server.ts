import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env, assertConfigValid, configSummary } from "./lib/env";
import { prisma, disconnect, assertLedgerImmutable } from "./lib/prisma";
import { errorHandler } from "./lib/errors";
import { checkoutRouter, webhookRouter } from "./routes/checkout";
import { apiRouter } from "./routes/api";
import { devRouter } from "./routes/dev";
import { internalRouter } from "./routes/internal";
import { startScheduler } from "./scheduler";

// Refuse to start on bad configuration rather than silently disabling a
// security control. Runs before anything opens a socket.
assertConfigValid();

// express's res.json() uses JSON.stringify, which throws on BigInt. Byte
// counters are BIGINT columns; they will not realistically exceed
// Number.MAX_SAFE_INTEGER (9 petabytes) for one peer.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

const app = express();
app.set("trust proxy", 1); // so req.ip is the client, not the load balancer

// Baseline security headers. contentSecurityPolicy is off because this is a
// JSON API — the CSP that matters is the one the frontend sets on the pages a
// browser actually renders (see frontend/next.config.ts).
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  })
);

/**
 * The frontend is a separate origin (Next.js on :3000, this API on :3001), and
 * the session cookie rides on credentialed requests.
 *
 * An explicit allowlist, never a reflected origin: echoing back whatever
 * Origin arrives while also sending Allow-Credentials would let any website
 * read a logged-in customer's wallet, devices and ledger. Unknown origins get
 * no Allow-Origin header at all, which is what makes the browser refuse.
 *
 * Requests with no Origin (curl, the node agents, server-to-server) are not
 * CORS requests and are left alone — they are still subject to every auth
 * check on the route.
 */
const allowedOrigins = new Set(env.corsAllowedOrigins);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      return callback(null, allowedOrigins.has(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    maxAge: 600,
  })
);

// The Stripe webhook needs the raw body, so it is mounted before express.json().
app.use(webhookRouter(prisma));

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(internalRouter(prisma)); // node agents, bearer-token authenticated
app.use(checkoutRouter(prisma));
app.use(apiRouter(prisma));
app.use(devRouter(prisma)); // empty router unless ENABLE_DEV_ROUTES=true

// The legacy single-file test app in public/. It predates the Next.js
// frontend and is not maintained; serving it in production would put an
// unreviewed UI on the API's own origin, so it is development-only.
if (!env.isProduction) {
  app.use(express.static(path.join(__dirname, "..", "public")));
}

// Must be last: turns a thrown error into a response instead of a hung socket.
app.use(errorHandler);

// A process that has thrown an unhandled exception is in an undefined state.
// The old code wrote a file and carried on, which is how a half-dead server
// keeps accepting requests it cannot serve. Log it and let the supervisor
// restart us.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection:", reason);
  process.exit(1);
});

let server: ReturnType<typeof app.listen>;

async function main() {
  // Checked here, not just documented in app_role.sql: a superuser DATABASE_URL
  // means the "immutable" ledger is editable no matter what the code says.
  await assertLedgerImmutable();

  server = app.listen(env.PORT, () => {
    console.log(`TickVPN API listening on :${env.PORT}`);
    console.table(configSummary());
  });

  const stopScheduler = startScheduler(prisma);

  async function shutdown(signal: string) {
    console.log(`\n${signal} received, shutting down`);
    stopScheduler();
    server.close(() => {
      disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[fatal] failed to start:", err);
  process.exit(1);
});

export { app, server };
