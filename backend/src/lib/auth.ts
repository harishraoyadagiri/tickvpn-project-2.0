import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";

const TOKEN_TTL_MINUTES = 15;
const SESSION_TTL_HOURS = 24 * 7;

// In-memory for MVP scaffold — swap for Redis/DB table before production.
const loginTokens = new Map<string, { userId: string; expiresAt: number; used: boolean }>();
const sessions = new Map<string, { userId: string; expiresAt: number }>();

export function issueLoginToken(userId: string) {
  const token = crypto.randomBytes(32).toString("hex");
  loginTokens.set(token, {
    userId,
    expiresAt: Date.now() + TOKEN_TTL_MINUTES * 60 * 1000,
    used: false,
  });
  return token; // caller emails this as a magic link
}

export function verifyLoginToken(token: string): string | null {
  const record = loginTokens.get(token);
  if (!record || record.used || record.expiresAt < Date.now()) return null;
  record.used = true; // single-use
  return record.userId;
}

export function createSession(userId: string): string {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, { userId, expiresAt: Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000 });
  return sessionId;
}

export function destroySession(sessionId: string) {
  sessions.delete(sessionId);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.session;
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session || session.expiresAt < Date.now()) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  (req as any).userId = session.userId;
  next();
}

export async function getOrCreateUser(prisma: PrismaClient, email: string) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      wallet: { create: { balance: 0 } },
    },
  });
  return user;
}
