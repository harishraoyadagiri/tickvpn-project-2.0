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

  const used = await prisma.rateLimitHit.count({ where: { bucket, createdAt: { gte: since } } });

  if (used >= limit) {
    const oldest = await prisma.rateLimitHit.findFirst({
      where: { bucket, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
    });
    const retryAfterSeconds = oldest
      ? Math.max(1, Math.ceil((oldest.createdAt.getTime() + windowMs - Date.now()) / 1000))
      : Math.ceil(windowMs / 1000);
    return { allowed: false, used, retryAfterSeconds };
  }

  await prisma.rateLimitHit.create({ data: { bucket } });
  return { allowed: true, used: used + 1, retryAfterSeconds: 0 };
}

/** Delete hits older than the longest window we use. Called by the scheduler. */
export async function sweep(prisma: PrismaClient, olderThanMs = 6 * 60 * 60 * 1000) {
  const { count } = await prisma.rateLimitHit.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - olderThanMs) } },
  });
  return count;
}
