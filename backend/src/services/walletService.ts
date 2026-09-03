import { Prisma, PrismaClient, TxType, WalletUnit } from "@prisma/client";

/**
 * Every balance change goes through this file. No route, webhook, service or
 * admin action touches wallet.minuteBalance directly.
 *
 * Minutes are the only currency. A Day Pass credits 1440 of them; they are
 * consumed only while a device is actually carrying traffic. (The DAY unit and
 * `balance` column are retired and kept for historical ledger rows only.)
 *
 * Two guarantees:
 *  1. Idempotency — every caller passes a key derived from the entity the
 *     change belongs to (a session id, a Stripe event id, a purchase id).
 *     Never wall-clock time: an hour-granular key silently returns someone
 *     else's transaction and skips the balance check.
 *  2. Atomicity — read and write happen inside one transaction holding a row
 *     lock, so concurrent debits cannot both see the same "before" balance.
 */

export class InsufficientBalanceError extends Error {
  constructor(public unit: WalletUnit = "MINUTE") {
    super(unit === "DAY" ? "Insufficient VPN Day balance" : "Insufficient minute balance");
    this.name = "InsufficientBalanceError";
  }
}

export interface ApplyTxParams {
  userId: string;
  type: TxType;
  /** Signed: positive credits, negative debits. */
  amount: number;
  unit?: WalletUnit;
  referenceType?: string;
  referenceId?: string;
  /** Required and stable. See the note above. */
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  /**
   * Clamp a debit at zero instead of throwing. Used by refunds and by the
   * metering loop, where billing what is left is correct and refusing is not.
   */
  clampAtZero?: boolean;
}

export interface ApplyTxResult {
  transaction: Prisma.WalletTransactionGetPayload<{}>;
  alreadyApplied: boolean;
  /** How much was actually applied — differs from `amount` when clamped. */
  applied: number;
  balanceAfter: number;
}

/**
 * Core logic against an open transaction client. Callers already inside a
 * `$transaction` (metering, which must commit the debit and the session update
 * together) call this directly; everyone else uses applyWalletTransaction.
 */
export async function applyWalletTransactionWithTx(
  tx: Prisma.TransactionClient,
  params: ApplyTxParams
): Promise<ApplyTxResult> {
  const { userId, type, referenceType, referenceId, idempotencyKey, metadata } = params;
  const unit: WalletUnit = params.unit ?? "MINUTE";

  if (!idempotencyKey || idempotencyKey.trim() === "") {
    throw new Error("idempotencyKey is required for every wallet transaction");
  }
  if (!Number.isInteger(params.amount)) {
    throw new Error(`amount must be an integer, got ${params.amount}`);
  }

  const existing = await tx.walletTransaction.findUnique({ where: { idempotencyKey } });
  if (existing) {
    return {
      transaction: existing,
      alreadyApplied: true,
      applied: existing.amount,
      balanceAfter: existing.balanceAfter,
    };
  }

  // Lock the whole wallet row so a credit and a debit for the same user
  // serialise against each other. Prisma has no first-class FOR UPDATE.
  const locked: { id: string; balance: number; minuteBalance: number }[] = await tx.$queryRaw`
    SELECT id, balance, "minuteBalance" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE
  `;
  if (locked.length === 0) throw new Error(`No wallet found for user ${userId}`);
  const wallet = locked[0];

  const current = unit === "DAY" ? wallet.balance : wallet.minuteBalance;

  let amount = params.amount;
  if (current + amount < 0) {
    if (!params.clampAtZero) throw new InsufficientBalanceError(unit);
    amount = -current; // spend exactly what is left
  }

  const balanceAfter = current + amount;

  if (amount !== 0) {
    await tx.wallet.update({
      where: { id: wallet.id },
      data: unit === "DAY" ? { balance: balanceAfter } : { minuteBalance: balanceAfter },
    });
  }

  const transaction = await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      type,
      unit,
      amount,
      balanceBefore: current,
      balanceAfter,
      referenceType,
      referenceId,
      idempotencyKey,
      metadata: metadata as any,
    },
  });

  return { transaction, alreadyApplied: false, applied: amount, balanceAfter };
}

/** For callers not already inside a transaction (routes, webhooks). */
export async function applyWalletTransaction(
  prisma: PrismaClient,
  params: ApplyTxParams
): Promise<ApplyTxResult> {
  return prisma.$transaction((tx) => applyWalletTransactionWithTx(tx, params));
}

export async function getBalances(prisma: PrismaClient, userId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error(`No wallet found for user ${userId}`);
  return { minuteBalance: wallet.minuteBalance, balance: wallet.balance };
}

export async function getLedger(prisma: PrismaClient, userId: string, limit = 50) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error(`No wallet found for user ${userId}`);
  return prisma.walletTransaction.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  });
}
