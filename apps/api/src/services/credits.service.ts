import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { creditBalances, creditTransactions } from '../db/schema.js';

// ── Credit cost configuration ─────────────────────────
export const CREDIT_COSTS: Record<string, number> = {
  spec_analysis: 1,
  document_generation: 3,
  drift_detection: 2,
  ticket_generation: 2,
  voice_agent_minute: 5,
  agent_full_spec_review: 5,
  agent_change_impact_analysis: 4,
  agent_codebase_sync_check: 4,
  agent_doc_generation: 5,
  agent_meeting_review: 3,
  agent_custom: 3,
};

/**
 * Returns the credit cost for a given agent workflow.
 * Falls back to the generic `agent_custom` cost for unknown workflows.
 */
export function getAgentCost(workflowId?: string): number {
  const key = workflowId ? `agent_${workflowId}` : 'agent_custom';
  return CREDIT_COSTS[key] ?? CREDIT_COSTS.agent_custom;
}

/**
 * Check whether a user has enough credits for the given amount.
 * Returns `{ allowed: true, balance }` or `{ allowed: false, balance, required }`.
 */
export async function checkCredits(
  userId: string,
  required: number,
): Promise<{ allowed: boolean; balance: number; required: number }> {
  const balance = await getBalance(userId);
  return { allowed: balance >= required, balance, required };
}

// ── Service functions ─────────────────────────────────

export async function getBalance(userId: string): Promise<number> {
  const [row] = await db
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1);

  return row?.balance ?? 0;
}

export async function addCredits(
  userId: string,
  amount: number,
  description: string,
  stripeSessionId?: string,
): Promise<{ balance: number; added: number }> {
  if (amount <= 0) {
    throw { statusCode: 400, message: 'Amount must be positive' };
  }

  // Upsert balance
  await db
    .insert(creditBalances)
    .values({ userId, balance: amount })
    .onConflictDoUpdate({
      target: creditBalances.userId,
      set: {
        balance: sql`${creditBalances.balance} + ${amount}`,
        updatedAt: new Date(),
      },
    });

  // Record transaction
  await db.insert(creditTransactions).values({
    userId,
    amount,
    type: 'purchase',
    description,
    stripeSessionId: stripeSessionId ?? null,
  });

  const newBalance = await getBalance(userId);
  return { balance: newBalance, added: amount };
}

export async function deductCredits(
  userId: string,
  amount: number,
  taskType: string,
  description: string,
): Promise<{ balance: number }> {
  if (amount <= 0) {
    throw { statusCode: 400, message: 'Amount must be positive' };
  }

  const currentBalance = await getBalance(userId);

  if (currentBalance < amount) {
    throw {
      statusCode: 402,
      message: `Insufficient credits. Current balance: ${currentBalance}, required: ${amount}`,
    };
  }

  // Deduct from balance
  await db
    .update(creditBalances)
    .set({
      balance: sql`${creditBalances.balance} - ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(creditBalances.userId, userId));

  // Record transaction (negative amount for consumption)
  await db.insert(creditTransactions).values({
    userId,
    amount: -amount,
    type: 'consumption',
    description,
    taskType,
  });

  const newBalance = await getBalance(userId);
  return { balance: newBalance };
}

export async function getTransactionHistory(
  userId: string,
  limit = 50,
): Promise<
  {
    id: string;
    amount: number;
    type: string;
    description: string;
    taskType: string | null;
    createdAt: Date;
  }[]
> {
  const rows = await db
    .select({
      id: creditTransactions.id,
      amount: creditTransactions.amount,
      type: creditTransactions.type,
      description: creditTransactions.description,
      taskType: creditTransactions.taskType,
      createdAt: creditTransactions.createdAt,
    })
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId))
    .orderBy(desc(creditTransactions.createdAt))
    .limit(limit);

  return rows;
}
