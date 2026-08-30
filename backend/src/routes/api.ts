import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth, issueLoginToken, verifyLoginToken, createSession, destroySession, getOrCreateUser } from "../lib/auth";
import { getBalances, getLedger } from "../services/walletService";
import { provisionDevice, revokeDevice } from "../services/provisioningService";
import { startOrExtendUsageWindow, getCurrentUsage } from "../services/usageService";
import { InsufficientBalanceError } from "../services/walletService";
import { tickTimeSession } from "../services/timeUsageService";
import { BASE_RATE, DECAY_EXP, TICK_PASS_TIERS, formulaPriceCents } from "../services/pricingService";
import { getTrending } from "../services/contentDiscoveryService";

export function apiRouter(prisma: PrismaClient) {
  const router = Router();

  // ---- Auth ----
  router.post("/auth/login", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email required" });
    const user = await getOrCreateUser(prisma, email);
    const token = issueLoginToken(user.id);
    // TODO: send via email provider. In dev, returned directly so the
    // browser test app can verify without needing real email delivery.
    console.log(`[dev] magic link token for ${email}: ${token}`);
    const devToken = process.env.NODE_ENV === "production" ? undefined : token;
    return res.json({ ok: true, devToken });
  });

  router.post("/auth/verify", async (req, res) => {
    const { token } = req.body;
    const userId = verifyLoginToken(token);
    if (!userId) return res.status(401).json({ error: "Invalid or expired token" });
    const sessionId = createSession(userId);
    res.cookie("session", sessionId, { httpOnly: true, secure: true, sameSite: "lax" });
    return res.json({ ok: true });
  });

  router.post("/auth/logout", requireAuth, (req, res) => {
    destroySession(req.cookies.session);
    res.clearCookie("session");
    return res.json({ ok: true });
  });

  // ---- Products ----
  router.get("/products", async (_req, res) => {
    const products = await prisma.product.findMany({ where: { active: true } });
    return res.json(products);
  });

  // ---- Pricing ----
  // Public (shown on the landing page before login) — the formula + named
  // tiers, so the frontend never hardcodes prices or the curve shape.
  // Custom/arbitrary minute amounts are quoted live via ?minutes=.
  router.get("/pricing/model", (req, res) => {
    const minutesQuery = req.query.minutes;
    const quote = minutesQuery ? formulaPriceCents(Number(minutesQuery)) : undefined;
    return res.json({ baseRate: BASE_RATE, decayExp: DECAY_EXP, tiers: TICK_PASS_TIERS, quoteCents: quote });
  });

  // ---- Content discovery ----
  // Public — no auth required. V1 scope per content-discovery-scope.md:
  // in-app (logged in) plus a lightweight home-page teaser. No real IP
  // geo-detection here — the caller picks a region explicitly (that's
  // the deferred V2 "pre-login public discovery" build, not this).
  router.get("/content/trending", async (req, res) => {
    const region = typeof req.query.region === "string" ? req.query.region : "us";
    try {
      const data = await getTrending(region);
      return res.json(data);
    } catch (err) {
      console.error("[content-discovery] getTrending threw unexpectedly:", err);
      return res.status(500).json({ error: "content_discovery_unavailable" });
    }
  });

  // ---- Regions ----
  router.get("/regions", async (_req, res) => {
    const regions = await prisma.region.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
    });
    return res.json(regions);
  });

  // ---- Wallet ----
  router.get("/wallet", requireAuth, async (req, res) => {
    const { balance, minuteBalance } = await getBalances(prisma, (req as any).userId);
    return res.json({ balance, minuteBalance });
  });

  router.get("/wallet/transactions", requireAuth, async (req, res) => {
    const ledger = await getLedger(prisma, (req as any).userId);
    return res.json(ledger);
  });

  // ---- Devices ----
  router.get("/devices", requireAuth, async (req, res) => {
    const devices = await prisma.device.findMany({ where: { userId: (req as any).userId } });
    return res.json(devices);
  });

  router.post("/devices", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    const { name, publicKey } = req.body;

    const activeCount = await prisma.device.count({ where: { userId, status: "ACTIVE" } });
    const MAX_DEVICES = 3;
    if (activeCount >= MAX_DEVICES) {
      return res.status(400).json({ error: `Max ${MAX_DEVICES} devices reached` });
    }

    const device = await prisma.device.create({
      data: { userId, name, publicKey, status: "ACTIVE" },
    });
    return res.json(device);
  });

  router.delete("/devices/:id", requireAuth, async (req, res) => {
    const device = await revokeDevice(prisma, req.params.id);
    return res.json(device);
  });

  // ---- VPN provisioning ----
  router.post("/vpn/provision", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    const { regionCode, devicePublicKey, deviceName } = req.body;

    try {
      const result = await provisionDevice(prisma, {
        userId,
        regionCode,
        devicePublicKey,
        deviceName,
      });
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  // Called by node connection webhook/heartbeat, not directly by the client.
  router.post("/vpn/connect-event", async (req, res) => {
    const { userId, nodeSecret } = req.body;
    if (nodeSecret !== process.env.NODE_SHARED_SECRET) {
      return res.status(403).json({ error: "Unauthorized node" });
    }
    try {
      const result = await startOrExtendUsageWindow(prisma, userId);
      return res.json(result);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return res.status(402).json({ error: "insufficient_balance", cta: "buy_more_days" });
      }
      throw err;
    }
  });

  router.get("/usage/current", requireAuth, async (req, res) => {
    const window = await getCurrentUsage(prisma, (req as any).userId);
    return res.json({ window });
  });

  router.get("/vpn/status", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    // Ticking here means every status poll (the dashboard polls on a timer
    // whenever a time session is active) also bills elapsed metered minutes,
    // so the meter advances even without a dedicated action from the user.
    const [{ balance, minuteBalance }, window, timeTick] = await Promise.all([
      getBalances(prisma, userId),
      getCurrentUsage(prisma, userId),
      tickTimeSession(prisma, userId),
    ]);
    return res.json({
      balance,
      minuteBalance: timeTick.minuteBalance ?? minuteBalance,
      activeWindow: window,
      activeTimeSession: timeTick.session,
      timeSessionRanOut: timeTick.ranOut,
    });
  });

  return router;
}
