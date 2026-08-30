import { Prisma, PrismaClient, TxType, WalletUnit } from "@prisma/client";

/**
 * Every balance change goes through this file. No route, webhook, or admin
 * action should ever touch wallet.balance / wallet.minuteBalance directly.
 *
 * A wallet has two independent balances:
 *  - balance        whole VPN Days (unit: DAY) — flat charge per 24h window
 *  - minuteBalance  metered minutes (unit: MINUTE) — for short time passes
 *
 * Two guarantees this enforces, for either unit:
 * 1. Idempotency: pass a stable idempotencyKey (e.g. Stripe event id, or
 *    `usage:${userId}:${windowStartIso}`). If that key has already been
 *    used, we return the existing transaction instead of double-applying it.
 * 2. Atomicity: balance read + write happens inside one DB transaction with
 *    a row lock, so concurrent requests can't both see the same "before"
 *    balance and both succeed.
 */

export class InsufficientBalanceError extends Error {
  constructor(unit: WalletUnit = "DAY") {
    super(unit === "MINUTE" ? "Insufficient time-pass minute balance" : "Insufficient VPN Day balance");
    this.name = "InsufficientBalanceError";
  }
}

interface ApplyTxParams {
  userId: string;
  type: TxType;
  amount: number; // signed: positive = credit, negative = debit
  unit?: WalletUnit; // defaults to DAY — set to MINUTE for time-pack transactions
  referenceType?: string;
  referenceId?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

/**
 * Core logic, given a Prisma client OR an already-open transaction client.
 * Callers that are already inside a `prisma.$transaction(async (tx) => ...)`
 * (e.g. usageService/timeUsageService, which need the wallet debit and a
 * window/session row to commit atomically together) should call this
 * directly with their `tx`, instead of `applyWalletTransaction`, since
 * transaction clients can't open a nested transaction of their own.
 */
async function applyWalletTransactionWithTx(
  tx: Prisma.TransactionClient,
  params: ApplyTxParams
) {
  const { userId, type, amount, referenceType, referenceId, idempotencyKey, metadata } = params;
  const unit: WalletUnit = params.unit ?? "DAY";

  // Idempotency check first — cheap, no lock needed.
  const existing = await tx.walletTransaction.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    return { transaction: existing, alreadyApplied: true };
  }

  // Lock the wallet row for this user so concurrent debits/credits serialize
  // — locking the whole row (not just one column) also means a DAY tx and a
  // MINUTE tx for the same user can't race each other either.
  // Prisma doesn't expose SELECT ... FOR UPDATE directly, so we use $queryRaw.
  const locked: { id: string; balance: number; minuteBalance: number }[] = await tx.$queryRaw`
    SELECT id, balance, "minuteBalance" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE
  `;
  if (locked.length === 0) {
    throw new Error(`No wallet found for user ${userId}`);
  }
  const wallet = locked[0];

  const currentBalance = unit === "MINUTE" ? wallet.minuteBalance : wallet.balance;
  const balanceAfter = currentBalance + amount;
  if (balanceAfter < 0) {
    throw new InsufficientBalanceError(unit);
  }

  await tx.wallet.update({
    where: { id: wallet.id },
    data: unit === "MINUTE" ? { minuteBalance: balanceAfter } : { balance: balanceAfter },
  });

  const transaction = await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      type,
      unit,
      amount,
      balanceBefore: currentBalance,
      balanceAfter,
      referenceType,
      referenceId,
      idempotencyKey,
      metadata: metadata as any,
    },
  });

  return { transaction, alreadyApplied: false };
}

/**
 * Public entry point for callers that are NOT already inside a transaction
 * (routes, webhooks). Opens its own atomic transaction with a row lock.
 */
export async function applyWalletTransaction(prisma: PrismaClient, params: ApplyTxParams) {
  return prisma.$transaction((tx) => applyWalletTransactionWithTx(tx, params));
}

export { applyWalletTransactionWithTx };

export async function getBalance(prisma: PrismaClient, userId: string): Promise<number> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error(`No wallet found for user ${userId}`);
  return wallet.balance;
}

export async function getMinuteBalance(prisma: PrismaClient, userId: string): Promise<number> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error(`No wallet found for user ${userId}`);
  return wallet.minuteBalance;
}

export async function getBalances(
  prisma: PrismaClient,
  userId: string
): Promise<{ balance: number; minuteBalance: number }> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error(`No wallet found for user ${userId}`);
  return { balance: wallet.balance, minuteBalance: wallet.minuteBalance };
}

export async function getLedger(prisma: PrismaClient, userId: string, limit = 50) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error(`No wallet found for user ${userId}`);
  return prisma.walletTransaction.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
