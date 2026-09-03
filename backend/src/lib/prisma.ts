import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env } from "./env";

/**
 * The one place a PrismaClient is constructed.
 *
 * We use the pg driver adapter with Prisma's query compiler rather than the
 * Rust query engine. Two reasons: installs and CI no longer download a ~40 MB
 * platform-specific binary from binaries.prisma.sh (which fails outright on
 * restricted networks), and pooling is handled by `pg`, which we already need
 * for the raw FOR UPDATE lock in walletService.
 */
const pool = new Pool({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);

export type Db = typeof prisma;

export async function disconnect() {
  await prisma.$disconnect();
  await pool.end();
}
