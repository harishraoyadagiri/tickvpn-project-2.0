import fs from "fs";
import path from "path";
import express from "express";
import cookieParser from "cookie-parser";
import { PrismaClient } from "@prisma/client";
import { checkoutRouter, webhookRouter } from "./routes/checkout";
import { apiRouter } from "./routes/api";
import { devRouter } from "./routes/dev";

// express's res.json() uses JSON.stringify, which throws on BigInt
// ("Do not know how to serialize a BigInt") — and UsageWindow.bytesUsed /
// TimeSession.bytesUsed are BigInt columns (Prisma's mapping for Postgres
// BIGINT). This makes BigInt values serialize as plain numbers everywhere,
// which is safe here: bandwidth-used counters won't realistically exceed
// Number.MAX_SAFE_INTEGER (9 petabytes) in this product.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

const prisma = new PrismaClient();
const app = express();

// Webhook route needs raw body BEFORE express.json() runs — mount it first.
app.use(webhookRouter(prisma));

app.use(express.json());
app.use(cookieParser());

app.use(checkoutRouter(prisma));
app.use(apiRouter(prisma));
app.use(devRouter(prisma)); // dev-only test endpoints, blocked in production

// Serves public/index.html at http://localhost:PORT — the connected test app.
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`TickVPN API listening on :${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser to try it.`);
  // Dev-only heartbeat file — lets tooling confirm the server actually came
  // up (and when) without needing to read the console window.
  try {
    fs.writeFileSync(
      path.join(__dirname, "..", "server-status.txt"),
      `UP ${new Date().toISOString()} port=${PORT}\n`
    );
  } catch {
    /* non-fatal — just a debug aid */
  }
});

process.on("uncaughtException", (err) => {
  try {
    fs.writeFileSync(
      path.join(__dirname, "..", "server-status.txt"),
      `CRASHED ${new Date().toISOString()} ${err?.stack || err}\n`
    );
  } catch {
    /* ignore */
  }
  console.error(err);
});
