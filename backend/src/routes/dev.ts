import { Router } from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../lib/auth";
import { applyWalletTransaction, InsufficientBalanceError } from "../services/walletService";
import { startOrExtendUsageWindow } from "../services/usageService";
import { startTimeSession, tickTimeSession, endTimeSession, getTimeStatus } from "../services/timeUsageService";

/**
 * These routes exist ONLY so the wallet, usage-window, and time-session
 * logic can be clicked through in a browser before Stripe and real VPN
 * nodes exist. All are hard-blocked outside development so they can never
 * ship live.
 *
 *  - /dev/credit-wallet        stands in for a completed Stripe purchase of a VPN Days pack
 *  - /dev/credit-minutes       stands in for a completed Stripe purchase of a time pass
 *  - /vpn/test-connect         stands in for a real node reporting "user connected" (day-pass / window mode)
 *  - /vpn/test-connect-timed   same, but for a metered time-pass session
 *  - /vpn/test-disconnect-timed stands in for a real node reporting "user disconnected" (stops the meter)
 */
export function devRouter(prisma: PrismaClient) {
  const router = Router();

  router.use((_req, res, next) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not available" });
    }
    next();
  });

  router.post("/dev/credit-wallet", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    const days = Number(req.body?.days) || 10;

    const { transaction } = await applyWalletTransaction(prisma, {
      userId,
      type: "PROMOTIONAL",
      amount: days,
      referenceType: "dev_test_credit",
      idempotencyKey: `dev:${userId}:${crypto.randomUUID()}`,
    });

    return res.json({ transaction });
  });

  router.post("/vpn/test-connect", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    try {
      const result = await startOrExtendUsageWindow(prisma, userId);
      return res.json(result);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return res.status(402).json({ error: "insufficient_balance" });
      }
      throw err;
    }
  });

  router.post("/dev/credit-minutes", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    const minutes = Number(req.body?.minutes) || 60;

    const { transaction } = await applyWalletTransaction(prisma, {
      userId,
      type: "PROMOTIONAL",
      amount: minutes,
      unit: "MINUTE",
      referenceType: "dev_test_credit",
      idempotencyKey: `dev:${userId}:${crypto.randomUUID()}`,
    });

    return res.json({ transaction });
  });

  router.post("/vpn/test-connect-timed", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    try {
      const result = await startTimeSession(prisma, userId);
      return res.json(result);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return res.status(402).json({ error: "insufficient_balance" });
      }
      throw err;
    }
  });

  // Called periodically while a time session is active, so the meter
  // actually advances (and the UI reflects the running balance).
  router.post("/vpn/tick-timed", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    const result = await tickTimeSession(prisma, userId);
    return res.json(result);
  });

  router.post("/vpn/test-disconnect-timed", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    const result = await endTimeSession(prisma, userId);
    return res.json(result);
  });

  router.get("/vpn/status-timed", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    const result = await getTimeStatus(prisma, userId);
    return res.json(result);
  });

  return router;
}
