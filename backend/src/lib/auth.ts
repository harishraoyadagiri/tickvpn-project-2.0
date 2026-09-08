import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import { env } from "./env";
import { asyncRoute, forbidden, unauthorized } from "./errors";

/**
 * Passwordless auth, per Technical Decisions D6.
 *
 * Sessions and login tokens live in Postgres, not in a process-local Map:
 * a restart no longer logs everyone out, a session can actually be revoked,
 * and the store cannot grow without bound.
 *
 * Only SHA-256 hashes are stored. The cookie and the emailed link carry the
 * secret; the database never does.
 */

const hash = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export interface AuthedRequest extends Request {
  userId?: string;
}

export async function getOrCreateUser(prisma: PrismaClient, email: string) {
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, wallet: { create: { minuteBalance: 0 } } },
  });
}

/** Returns the raw token; the caller emails it and never logs it in production. */
export async function issueLoginToken(prisma: PrismaClient, userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.loginToken.create({
    data: {
      tokenHash: hash(token),
      userId,
      expiresAt: new Date(Date.now() + env.LOGIN_TOKEN_TTL_MINUTES * 60_000),
    },
  });
  return token;
}

/**
 * Verify a magic link and open a session. Marking the token used and creating
 * the session happen in one transaction, so single-use really is single-use
 * even if two tabs race.
 */
export async function verifyLoginToken(
  prisma: PrismaClient,
  token: string
): Promise<{ sessionToken: string; userId: string } | null> {
  if (typeof token !== "string" || token.length < 16) return null;

  const sessionToken = crypto.randomBytes(32).toString("base64url");

  try {
    return await prisma.$transaction(async (tx) => {
      const record = await tx.loginToken.findUnique({ where: { tokenHash: hash(token) } });
      if (!record || record.usedAt || record.expiresAt < new Date()) return null;

      await tx.loginToken.update({
        where: { tokenHash: record.tokenHash },
        data: { usedAt: new Date() },
      });
      await tx.session.create({
        data: {
          tokenHash: hash(sessionToken),
          userId: record.userId,
          expiresAt: new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000),
        },
      });
      return { sessionToken, userId: record.userId };
    });
  } catch {
    return null;
  }
}

export async function destroySession(prisma: PrismaClient, sessionToken: string | undefined) {
  if (!sessionToken) return;
  await prisma.session.deleteMany({ where: { tokenHash: hash(sessionToken) } });
}

/** Revoke every session for a user — used by suspension and account deletion. */
export async function destroyAllSessions(prisma: PrismaClient, userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    maxAge: env.SESSION_TTL_HOURS * 3_600_000,
    path: "/",
  };
}

/**
 * Requires a live session AND an active user. A suspended account is rejected
 * here rather than in each route, so suspension takes effect everywhere at once.
 */
export function requireAuth(prisma: PrismaClient) {
  return asyncRoute(async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const raw = req.cookies?.session;
    if (!raw) throw unauthorized();

    const session = await prisma.session.findUnique({
      where: { tokenHash: hash(raw) },
      include: { user: { select: { id: true, status: true } } },
    });

    if (!session || session.expiresAt < new Date()) throw unauthorized();
    if (session.user.status !== "ACTIVE") throw forbidden("account_suspended");

    // Rolling expiry, written at most once a minute to avoid a write per request.
    if (Date.now() - session.lastUsedAt.getTime() > 60_000) {
      await prisma.session.update({
        where: { tokenHash: session.tokenHash },
        data: {
          lastUsedAt: new Date(),
          expiresAt: new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000),
        },
      });
    }

    req.userId = session.userId;
    next();
  });
}

/** Housekeeping for the scheduler. */
export async function sweepExpiredAuth(prisma: PrismaClient) {
  const now = new Date();
  const [sessions, tokens] = await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.loginToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } }),
  ]);
  return { sessions: sessions.count, tokens: tokens.count };
}
