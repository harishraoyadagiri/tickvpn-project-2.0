import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { asyncRoute, badRequest } from "../lib/errors";
import { requireNodeAuth, NodeRequest } from "../lib/nodeAuth";
import { processNodeReport, PeerReport } from "../services/meteringService";
import { computeAllowedPeers } from "../services/authorizationService";

/**
 * The node control plane. Only node agents talk to these, authenticated with a
 * per-node bearer token.
 *
 * Two endpoints, matching the two loops in Technical Decisions D2:
 *
 *   POST /api/internal/nodes/:nodeId/report   every 10 s — what the node sees
 *   GET  /api/internal/nodes/:nodeId/peers    every 15 s — who is allowed
 *
 * The agent makes wg0 match the peers list exactly. That is what makes a zero
 * balance actually disconnect somebody, and it is the only writer to wg0.
 */
export function internalRouter(prisma: PrismaClient) {
  const router = Router();

  router.post(
    "/api/internal/nodes/:nodeId/report",
    requireNodeAuth,
    asyncRoute(async (req: NodeRequest, res) => {
      const body = req.body;
      if (!body || !Array.isArray(body.peers)) throw badRequest("peers_required");
      if (body.peers.length > 1000) throw badRequest("too_many_peers");

      const peers: PeerReport[] = [];
      for (const p of body.peers) {
        if (typeof p?.publicKey !== "string") continue;
        const rx = BigInt(Math.max(0, Number(p.rxBytes ?? 0)));
        const tx = BigInt(Math.max(0, Number(p.txBytes ?? 0)));
        const hs = Number(p.latestHandshake ?? 0);
        peers.push({
          publicKey: p.publicKey,
          latestHandshake: Number.isFinite(hs) && hs > 0 ? Math.floor(hs) : 0,
          rxBytes: rx,
          txBytes: tx,
        });
      }

      const outcomes = await processNodeReport(prisma, req.nodeId as string, peers);

      return res.json({
        ok: true,
        processed: outcomes.length,
        // Tell the agent immediately about anyone who just ran out, so it can
        // drop them without waiting for the next reconcile.
        dropped: outcomes.filter((o) => o.ranOut).map((o) => o.deviceId),
      });
    })
  );

  router.get(
    "/api/internal/nodes/:nodeId/peers",
    requireNodeAuth,
    asyncRoute(async (req: NodeRequest, res) => {
      const peers = await computeAllowedPeers(prisma, req.nodeId as string);
      return res.json({ peers });
    })
  );

  return router;
}
