import { Router } from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { requireAuth, AuthedRequest } from "../lib/auth";
import { asyncRoute, badRequest } from "../lib/errors";
import { env } from "../lib/env";
import { generateAgentToken } from "../lib/nodeAuth";
import { applyWalletTransaction } from "../services/walletService";

/**
 * Local-only helpers so the wallet and metering can be exercised before Stripe
 * and real droplets exist.
 *
 * These are gated twice: env.enableDevRoutes requires an explicit
 * ENABLE_DEV_ROUTES=true, and that flag is forced false whenever
 * NODE_ENV=production. The old guard only checked that NODE_ENV was not
 * "production", so an unset NODE_ENV — the default on plenty of hosts — left
 * an endpoint live that mints unlimited balance.
 */
export function devRouter(prisma: PrismaClient) {
  const router = Router();
  if (!env.enableDevRoutes) return router;

  console.warn("[dev] DEV ROUTES ARE ENABLED — /dev/* can mint wallet balance");
  const auth = requireAuth(prisma);

  const credit = async (userId: string, minutes: number, note: string) => {
    const { transaction, balanceAfter } = await applyWalletTransaction(prisma, {
      userId,
      type: "PROMOTIONAL",
      amount: minutes,
      unit: "MINUTE",
      referenceType: "dev_test_credit",
      idempotencyKey: `dev:${crypto.randomUUID()}`,
      metadata: { note },
    });
    return { transaction, minuteBalance: balanceAfter };
  };

  /** A day's worth of pass: 1440 minutes. */
  router.post(
    "/dev/credit-day",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      const days = Number(req.body?.days ?? 1);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw badRequest("invalid_days");
      const result = await credit(req.userId as string, days * env.MINUTES_PER_DAY_PASS, `${days} day pass`);
      return res.json({ ...result, daysRemaining: result.minuteBalance / env.MINUTES_PER_DAY_PASS });
    })
  );

  router.post(
    "/dev/credit-minutes",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      const minutes = Number(req.body?.minutes ?? 60);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525_600) throw badRequest("invalid_minutes");
      return res.json(await credit(req.userId as string, minutes, "manual credit"));
    })
  );

  /**
   * Mint a bearer token for a node. Printed once and never stored in plaintext.
   * In production this is an admin action with an audit event, not a dev route.
   *
   * Still behind `auth` even though the whole router is dev-gated: this mints
   * a credential capable of controlling a node's peer set, and "reachable by
   * anyone with a session" is a meaningfully smaller blast radius than
   * "reachable by anyone who can route to :3001" if the dev-routes gate is
   * ever misconfigured.
   */
  router.post(
    "/dev/nodes/:nodeId/token",
    auth,
    asyncRoute(async (req, res) => {
      const node = await prisma.vPNNode.findUnique({ where: { id: req.params.nodeId } });
      if (!node) throw badRequest("node_not_found");
      const { token, hash } = generateAgentToken();
      await prisma.vPNNode.update({ where: { id: node.id }, data: { agentTokenHash: hash } });
      return res.json({ nodeId: node.id, hostname: node.hostname, agentToken: token });
    })
  );

  return router;
}
