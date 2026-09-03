import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  requireAuth,
  issueLoginToken,
  verifyLoginToken,
  destroySession,
  getOrCreateUser,
  cookieOptions,
  AuthedRequest,
} from "../lib/auth";
import { asyncRoute, badRequest, HttpError } from "../lib/errors";
import { env } from "../lib/env";
import { getBalances, getLedger } from "../services/walletService";
import { provisionDevice, revokeDevice } from "../services/provisioningService";
import { getConnectionStatus } from "../services/meteringService";
import { consume } from "../services/rateLimitService";
import { BASE_RATE, DECAY_EXP, TICK_PASS_TIERS, formulaPriceCents } from "../services/pricingService";
import { getTrending } from "../services/contentDiscoveryService";

const HOUR = 3_600_000;

export function apiRouter(prisma: PrismaClient) {
  const router = Router();
  const auth = requireAuth(prisma);

  // ─────────────────────────── Auth ───────────────────────────

  router.post(
    "/auth/login",
    asyncRoute(async (req, res) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw badRequest("invalid_email");
      }

      // Rate limit by IP and by email (D6). Both, not either.
      const ip = req.ip ?? "unknown";
      for (const bucket of [`login:ip:${ip}`, `login:email:${email}`]) {
        const r = await consume(prisma, bucket, env.LOGIN_RATE_LIMIT_PER_HOUR, HOUR);
        if (!r.allowed) {
          res.set("Retry-After", String(r.retryAfterSeconds));
          throw new HttpError(429, "rate_limited", undefined, { retryAfterSeconds: r.retryAfterSeconds });
        }
      }

      const user = await getOrCreateUser(prisma, email);
      const token = await issueLoginToken(prisma, user.id);

      // TODO: hand to Postmark/Resend once the provider exists. Until then the
      // token is only ever surfaced outside production.
      if (!env.isProduction) console.log(`[dev] magic link token for ${email}: ${token}`);

      // Always 200 regardless of whether the account existed — no enumeration.
      return res.json({ ok: true, ...(env.isProduction ? {} : { devToken: token }) });
    })
  );

  router.post(
    "/auth/verify",
    asyncRoute(async (req, res) => {
      const result = await verifyLoginToken(prisma, req.body?.token);
      if (!result) throw new HttpError(401, "invalid_or_expired_token");
      res.cookie("session", result.sessionToken, cookieOptions());
      return res.json({ ok: true });
    })
  );

  router.post(
    "/auth/logout",
    auth,
    asyncRoute(async (req, res) => {
      await destroySession(prisma, req.cookies?.session);
      res.clearCookie("session", { path: "/" });
      return res.json({ ok: true });
    })
  );

  // ────────────────────── Catalogue & pricing ──────────────────────

  router.get(
    "/products",
    asyncRoute(async (_req, res) => {
      const products = await prisma.product.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { durationMinutes: "asc" }],
      });
      return res.json(products);
    })
  );

  router.get(
    "/pricing/model",
    asyncRoute(async (req, res) => {
      let quoteCents: number | undefined;
      if (req.query.minutes !== undefined) {
        const minutes = Number(req.query.minutes);
        // The old version happily quoted NaN, Infinity, and 1.9 million years.
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525_600) {
          throw badRequest("invalid_minutes", "minutes must be an integer between 1 and 525600");
        }
        quoteCents = formulaPriceCents(minutes);
      }
      return res.json({
        baseRate: BASE_RATE,
        decayExp: DECAY_EXP,
        minutesPerDayPass: env.MINUTES_PER_DAY_PASS,
        tiers: TICK_PASS_TIERS,
        quoteCents,
      });
    })
  );

  router.get(
    "/regions",
    asyncRoute(async (_req, res) => {
      const regions = await prisma.region.findMany({
        where: { active: true },
        orderBy: { sortOrder: "asc" },
      });
      return res.json(regions);
    })
  );

  // ─────────────────────────── Wallet ───────────────────────────

  router.get(
    "/wallet",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      const { minuteBalance } = await getBalances(prisma, req.userId as string);
      return res.json({
        minuteBalance,
        daysRemaining: +(minuteBalance / env.MINUTES_PER_DAY_PASS).toFixed(3),
      });
    })
  );

  router.get(
    "/wallet/transactions",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      return res.json(await getLedger(prisma, req.userId as string));
    })
  );

  // ─────────────────────────── Devices ───────────────────────────

  router.get(
    "/devices",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      const devices = await prisma.device.findMany({
        where: { userId: req.userId as string },
        select: {
          id: true,
          name: true,
          status: true,
          internalIp: true,
          lastHandshakeAt: true,
          lastConnectedAt: true,
          createdAt: true,
          node: { select: { hostname: true, region: { select: { code: true, name: true } } } },
        },
        orderBy: { createdAt: "asc" },
      });
      return res.json(devices);
    })
  );

  // Creating a device and provisioning it are the same operation — the old
  // split let POST /devices enforce the cap while /vpn/provision bypassed it.
  router.post(
    "/devices",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      const result = await provisionDevice(prisma, {
        userId: req.userId as string,
        regionCode: String(req.body?.regionCode ?? "us"),
        devicePublicKey: req.body?.publicKey ?? req.body?.devicePublicKey,
        deviceName: req.body?.name ?? req.body?.deviceName,
      });
      return res.status(201).json(result);
    })
  );

  router.delete(
    "/devices/:id",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      // Scoped by userId inside revokeDevice — this used to be an IDOR.
      return res.json(await revokeDevice(prisma, req.userId as string, req.params.id));
    })
  );

  // ───────────────────────── VPN lifecycle ─────────────────────────

  router.post(
    "/vpn/provision",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      const result = await provisionDevice(prisma, {
        userId: req.userId as string,
        regionCode: String(req.body?.regionCode ?? "us"),
        devicePublicKey: req.body?.devicePublicKey,
        deviceName: req.body?.deviceName,
      });
      return res.json(result);
    })
  );

  // PRD §19 listed this and it was never built.
  router.post(
    "/vpn/change-region",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      const deviceId = String(req.body?.deviceId ?? "");
      const regionCode = String(req.body?.regionCode ?? "");
      if (!deviceId || !regionCode) throw badRequest("device_and_region_required");

      const device = await prisma.device.findFirst({
        where: { id: deviceId, userId: req.userId as string, status: "ACTIVE" },
      });
      if (!device) throw badRequest("device_not_found");

      // Switching region mid-session costs nothing extra: minutes are billed by
      // elapsed connected time, and the session is per user, not per node.
      const result = await provisionDevice(prisma, {
        userId: req.userId as string,
        regionCode,
        devicePublicKey: device.publicKey,
        deviceName: device.name,
      });
      return res.json(result);
    })
  );

  router.get(
    "/vpn/status",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      // Read-only. Polling this used to advance the meter, which meant a GET
      // mutated money and closing the tab stopped billing.
      return res.json(await getConnectionStatus(prisma, req.userId as string));
    })
  );

  router.get(
    "/usage/current",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      const session = await prisma.timeSession.findFirst({
        where: { userId: req.userId as string, status: "ACTIVE" },
      });
      return res.json({ session });
    })
  );

  // ─────────────────────── Content discovery ───────────────────────
  // V1 scope per content-discovery-scope.md is "in-app, logged-in only";
  // the public pre-login surface is a V2 item pending a legal review.

  router.get(
    "/content/trending",
    auth,
    asyncRoute(async (req, res) => {
      const region = typeof req.query.region === "string" ? req.query.region : "us";
      try {
        return res.json(await getTrending(region));
      } catch (err) {
        console.error("[content-discovery] unexpected failure:", err);
        throw new HttpError(503, "content_discovery_unavailable");
      }
    })
  );

  return router;
}
