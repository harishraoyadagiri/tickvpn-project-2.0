import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "./prisma";
import { asyncRoute, forbidden, notFound } from "./errors";

/**
 * Node agents authenticate with a per-node bearer token, not one shared secret.
 * D7: "a node holds nothing but device public keys and a bearer token scoped to
 * its own peer set. If a node is compromised, the blast radius is that node."
 *
 * Only the SHA-256 of the token is stored. Comparison is constant-time, and an
 * unset hash denies rather than allows — the old `!==` check passed when both
 * sides were undefined.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateAgentToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface NodeRequest extends Request {
  nodeId?: string;
}

/** Guards /api/internal/nodes/:nodeId/*. Fails closed in every branch. */
export const requireNodeAuth = asyncRoute(async (req: NodeRequest, _res: Response, next: NextFunction) => {
  const nodeId = req.params.nodeId;
  const header = req.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header.trim());

  if (!nodeId || !match) throw forbidden("node_unauthorized");

  const node = await prisma.vPNNode.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound("node_not_found");
  if (!node.agentTokenHash) throw forbidden("node_has_no_token");

  if (!safeEqualHex(hashToken(match[1]), node.agentTokenHash)) {
    throw forbidden("node_unauthorized");
  }

  req.nodeId = node.id;
  next();
});
