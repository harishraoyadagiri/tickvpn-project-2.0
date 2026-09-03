import { PrismaClient } from "@prisma/client";
import { closeAbandonedSessions } from "./services/meteringService";
import { sweep as sweepRateLimits } from "./services/rateLimitService";
import { sweepExpiredAuth } from "./lib/auth";

/**
 * Background housekeeping. Deliberately small and never load-bearing for
 * correctness — reads always use live predicates (D3), so if this stops
 * running nothing bills wrongly, rows just accumulate.
 */
export function startScheduler(prisma: PrismaClient) {
  const timers: NodeJS.Timeout[] = [];

  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    const run = () => {
      fn().catch((err) => console.error(`[scheduler] ${name} failed:`, err));
    };
    timers.push(setInterval(run, ms));
    run();
  };

  // A node that stops reporting must not leave a session ACTIVE forever: the
  // partial unique index would then block the user's next session.
  every(60_000, "close-abandoned-sessions", async () => {
    const n = await closeAbandonedSessions(prisma);
    if (n > 0) console.log(`[scheduler] closed ${n} abandoned session(s)`);
  });

  every(15 * 60_000, "sweep-rate-limits", () => sweepRateLimits(prisma));
  every(60 * 60_000, "sweep-expired-auth", () => sweepExpiredAuth(prisma));

  return () => timers.forEach(clearInterval);
}
