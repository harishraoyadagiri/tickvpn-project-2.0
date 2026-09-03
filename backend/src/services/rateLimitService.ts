import { PrismaClient } from "@prisma/client";

/**
 * Postgres-backed rate limiting. D6 chose this over Redis deliberately: one
 * fewer vendor at MVP scale, and it survives a restart.
 *
 * `consume` records a hit and returns false once the bucket is over its limit
 * within the window. Old hits are swept opportunistically.
 */
export async function consume(
  prisma: PrismaClient,
  bucket: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; used: number; retryAfterSeconds: number }> {
  const since = new Date(Date.now() - windowMs);

  // count-then-insert is only a real limit if concurrent callers for the same
  // bucket are serialized — otherwise two requests arriving at the limit
  // boundary can both read "under limit" before either has written its hit,
  // letting a burst exceed it. An advisory lock keyed on the bucket does that
  // without a second storage system (D6 chose Postgres over Redis).
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${bucket})::bigint)`;

    const used = await tx.rateLimitHit.count({ where: { bucket, createdAt: { gte: since } } });

    if (used >= limit) {
      const oldest = await tx.rateLimitHit.findFirst({
        where: { bucket, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
      });
      const retryAfterSeconds = oldest
        ? Math.max(1, Math.ceil((oldest.createdAt.getTime() + windowMs - Date.now()) / 1000))
        : Math.ceil(windowMs / 1000);
      return { allowed: false, used, retryAfterSeconds };
    }

    await tx.rateLimitHit.create({ data: { bucket } });
    return { allowed: true, used: used + 1, retryAfterSeconds: 0 };
  });
}

/** Delete hits older than the longest window we use. Called by the scheduler. */
export async function sweep(prisma: PrismaClient, olderThanMs = 6 * 60 * 60 * 1000) {
  const { count } = await prisma.rateLimitHit.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - olderThanMs) } },
  });
  return count;
}
