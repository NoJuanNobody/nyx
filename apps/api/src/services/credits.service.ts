import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { creditBalances, creditTransactions } from '../db/schema.js';
import type { CreditTaskType } from '../config/credit-costs.js';

// ── Balance ──────────────────────────────────────────────

/**
 * Get the current credit balance for a user.
 * Returns 0 if no balance record exists yet.
 */
export async function getBalance(userId: string): Promise<number> {
  const [row] = await db
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1);

  return row?.balance ?? 0;
}

// ── Deduct Credits ───────────────────────────────────────

/**
 * Atomically deduct credits from a user's balance.
 * Returns false if the user has insufficient credits (balance remains unchanged).
 * Returns true on success.
 */
export async function deductCredits(
  userId: string,
  amount: number,
  taskType: CreditTaskType,
  description: string,
): Promise<{ success: boolean; balance: number }> {
  // Use a transaction for atomicity
  return db.transaction(async (tx) => {
    // Lock the balance row
    const [existing] = await tx
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1);

    const currentBalance = existing?.balance ?? 0;

    if (currentBalance < amount) {
      return { success: false, balance: currentBalance };
    }

    const newBalance = currentBalance - amount;

    if (existing) {
      await tx
        .update(creditBalances)
        .set({ balance: newBalance, updatedAt: new Date() })
        .where(eq(creditBalances.userId, userId));
    } else {
      // Edge case: no balance row and amount is 0
      await tx.insert(creditBalances).values({ userId, balance: 0 });
    }

    await tx.insert(creditTransactions).values({
      userId,
      amount: -amount,
      type: 'consumption',
      description,
      taskType,
    });

    return { success: true, balance: newBalance };
  });
}

// ── Add Credits ──────────────────────────────────────────

/**
 * Add credits to a user's balance (purchase or refund).
 * Creates the balance row if it doesn't exist.
 */
export async function addCredits(
  userId: string,
  amount: number,
  type: 'purchase' | 'refund',
  description: string,
  stripeSessionId?: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1);

    let newBalance: number;

    if (existing) {
      newBalance = existing.balance + amount;
      await tx
        .update(creditBalances)
        .set({ balance: newBalance, updatedAt: new Date() })
        .where(eq(creditBalances.userId, userId));
    } else {
      newBalance = amount;
      await tx.insert(creditBalances).values({ userId, balance: newBalance });
    }

    await tx.insert(creditTransactions).values({
      userId,
      amount,
      type,
      description,
      stripeSessionId,
    });

    return newBalance;
  });
}

// ── Transaction History ──────────────────────────────────

export interface CreditTransaction {
  id: string;
  amount: number;
  type: 'purchase' | 'consumption' | 'refund';
  description: string;
  taskType: string | null;
  createdAt: string;
}

/**
 * Get paginated credit transaction history for a user.
 */
export async function getTransactionHistory(
  userId: string,
  limit = 50,
  offset = 0,
): Promise<{ transactions: CreditTransaction[]; total: number }> {
  const [rows, [{ count }]] = await Promise.all([
    db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId)),
  ]);

  return {
    transactions: rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      type: r.type,
      description: r.description,
      taskType: r.taskType,
      createdAt: r.createdAt.toISOString(),
    })),
    total: count,
  };
}
