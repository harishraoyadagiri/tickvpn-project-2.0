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

/**
 * D3 says ledger immutability is a database grant (prisma/sql/app_role.sql),
 * not a convention — but that grant is a manual step a superuser has to run
 * once, and nothing before this stopped the app from quietly running against
 * the superuser role forever if that step was skipped. A ledger you can
 * technically UPDATE/DELETE is not immutable no matter what the code says, so
 * this is checked at boot rather than trusted.
 *
 * In production this refuses to start. Outside production it only warns,
 * since local dev commonly runs against a superuser role and forcing every
 * contributor through app_role.sql just to run `npm run dev` isn't worth it.
 */
export async function assertLedgerImmutable(): Promise<void> {
  const rows = await prisma.$queryRaw<{ can_update: boolean; can_delete: boolean; is_superuser: boolean }[]>`
    SELECT
      has_table_privilege(current_user, '"WalletTransaction"', 'UPDATE') AS can_update,
      has_table_privilege(current_user, '"WalletTransaction"', 'DELETE') AS can_delete,
      COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser
  `;
  const row = rows[0];
  if (!row || (!row.can_update && !row.can_delete && !row.is_superuser)) return;

  const reasons = [
    row.can_update && "can UPDATE WalletTransaction",
    row.can_delete && "can DELETE WalletTransaction",
    row.is_superuser && "connects as a superuser role",
  ].filter(Boolean);
  const message =
    `Ledger is not immutable: the DATABASE_URL role ${reasons.join(" and ")}. ` +
    `Run prisma/sql/app_role.sql as a superuser and point DATABASE_URL at tickvpn_app.`;

  if (env.isProduction) {
    throw new Error(`Refusing to start — ${message}`);
  }
  console.warn(`[boot] WARNING: ${message}`);
}
