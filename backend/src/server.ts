import path from "path";
import express from "express";
import cookieParser from "cookie-parser";
import { env, assertConfigValid, configSummary } from "./lib/env";
import { prisma, disconnect } from "./lib/prisma";
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

// The Stripe webhook needs the raw body, so it is mounted before express.json().
app.use(webhookRouter(prisma));

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(internalRouter(prisma)); // node agents, bearer-token authenticated
app.use(checkoutRouter(prisma));
app.use(apiRouter(prisma));
app.use(devRouter(prisma)); // empty router unless ENABLE_DEV_ROUTES=true

app.use(express.static(path.join(__dirname, "..", "public")));

// Must be last: turns a thrown error into a response instead of a hung socket.
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
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

export { app, server };
