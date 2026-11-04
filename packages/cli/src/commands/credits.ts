import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

interface BalanceResponse {
  balance?: number;
  available?: number;
  [key: string]: unknown;
}

interface CostsResponse {
  costs: Record<string, number>;
}

interface Transaction {
  id: string;
  amount: number;
  type: string;
  description: string;
  taskType: string | null;
  createdAt: string;
}

interface TransactionsResponse {
  transactions: Transaction[];
}

function resolveAgent(explicit?: string): string {
  const id = explicit ?? process.env.NYX_AGENT_ID ?? 'default';
  if (/[\s:]/.test(id)) error('agent id must not contain whitespace or ":"');
  return id;
}

function parseAmount(raw: string, label: string, allowZero = false): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1)) {
    error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} whole number`);
  }
  return n;
}

/** Print a result; `--json` (or --format json) emits machine-readable JSON. */
function emit(data: unknown, opts: { json?: boolean; format?: OutputFormat }, human: string): void {
  if (opts.json || opts.format === 'json') {
    console.log(formatOutput(data, 'json'));
    return;
  }
  console.log('');
  console.log(`  ${human}`);
  console.log('');
}

/** On failure, --json prints the API error body (or a message) as JSON on stdout, then exits 1. */
function fail(err: unknown, opts: { json?: boolean; format?: OutputFormat }): never {
  const message = err instanceof Error ? err.message : String(err);
  if (opts.json || opts.format === 'json') {
    const brace = message.indexOf('{');
    let body: unknown = { error: message };
    if (brace >= 0) {
      try {
        body = JSON.parse(message.slice(brace));
      } catch {
        /* keep message */
      }
    }
    console.log(formatOutput(body, 'json'));
    process.exit(1);
  }
  return error(message);
}

interface JsonOpts {
  json?: boolean;
  format?: OutputFormat;
  agent?: string;
  idempotencyKey?: string;
  taskType?: string;
  memo?: string;
}

export function registerCreditsCommand(program: Command): void {
  const credits = program
    .command('credits')
    .description('Meter and spend agent credits (utility tokens; never sold)');

  // ── nyx credits balance ───────────────────────────────
  credits
    .command('balance')
    .description('Show an agent credit balance')
    .option('--agent <id>', 'Agent identity (default: NYX_AGENT_ID or "default")')
    .option('--json', 'Output JSON')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: JsonOpts) => {
      try {
        const client = new NyxClient();
        const agent = resolveAgent(opts.agent);
        const data = await client.get<BalanceResponse>(
          `/api/credits/balance?agentId=${encodeURIComponent(agent)}`,
        );
        const shown = data.available ?? data.balance;
        emit(data, opts, `Credit balance (${agent}): ${shown}`);
      } catch (err) {
        fail(err, opts);
      }
    });

  // ── nyx credits reserve <amount> ──────────────────────
  credits
    .command('reserve <amount>')
    .description('Hold credits for an in-flight operation; prints a reservation id')
    .option('--agent <id>', 'Agent identity')
    .option('--task-type <type>', 'Task type label')
    .option('--ttl-ms <ms>', 'Reservation expiry in milliseconds')
    .option('--memo <text>', 'Free-text memo')
    .option('--idempotency-key <key>', 'Retry-safe key (default: generated per invocation)')
    .option('--json', 'Output JSON')
    .action(async (amountRaw: string, opts: JsonOpts & { ttlMs?: string }) => {
      try {
        const amount = parseAmount(amountRaw, 'amount');
        const ttlMs = opts.ttlMs !== undefined ? parseAmount(opts.ttlMs, '--ttl-ms') : undefined;
        const key = opts.idempotencyKey ?? randomUUID();
        const data = await new NyxClient().post<Record<string, unknown>>(
          '/api/credits/reserve',
          {
            idempotencyKey: key,
            agentId: resolveAgent(opts.agent),
            amount,
            taskType: opts.taskType,
            ttlMs,
            memo: opts.memo,
          },
          { 'Idempotency-Key': key },
        );
        emit(data, opts, `Reserved ${amount} credits. Reservation: ${String(data.reservationId ?? '?')}`);
      } catch (err) {
        fail(err, opts);
      }
    });

  // ── nyx credits commit <reservation-id> <actual> ──────
  credits
    .command('commit <reservationId> <actual>')
    .description('Settle a reservation with the actual cost (<= reserved)')
    .option('--memo <text>', 'Free-text memo')
    .option('--idempotency-key <key>', 'Retry-safe key (default: generated per invocation)')
    .option('--json', 'Output JSON')
    .action(async (reservationId: string, actualRaw: string, opts: JsonOpts) => {
      try {
        const actualAmount = parseAmount(actualRaw, 'actual', true);
        const key = opts.idempotencyKey ?? randomUUID();
        const data = await new NyxClient().post<Record<string, unknown>>(
          '/api/credits/commit',
          { idempotencyKey: key, reservationId, actualAmount, memo: opts.memo },
          { 'Idempotency-Key': key },
        );
        emit(data, opts, `Committed ${actualAmount} credits on ${reservationId}.`);
      } catch (err) {
        fail(err, opts);
      }
    });

  // ── nyx credits release <reservation-id> ──────────────
  credits
    .command('release <reservationId>')
    .description('Cancel a reservation and return held credits to the agent budget')
    .option('--memo <text>', 'Free-text memo')
    .option('--idempotency-key <key>', 'Retry-safe key (default: generated per invocation)')
    .option('--json', 'Output JSON')
    .action(async (reservationId: string, opts: JsonOpts) => {
      try {
        const key = opts.idempotencyKey ?? randomUUID();
        const data = await new NyxClient().post<Record<string, unknown>>(
          '/api/credits/release',
          { idempotencyKey: key, reservationId, memo: opts.memo },
          { 'Idempotency-Key': key },
        );
        emit(data, opts, `Released reservation ${reservationId}.`);
      } catch (err) {
        fail(err, opts);
      }
    });

  // ── nyx credits spend <amount> ────────────────────────
  credits
    .command('spend <amount>')
    .description('Spend a known cost in one step (reserve + commit)')
    .option('--agent <id>', 'Agent identity')
    .option('--task-type <type>', 'Task type label')
    .option('--memo <text>', 'Free-text memo')
    .option('--idempotency-key <key>', 'Retry-safe key (default: generated per invocation)')
    .option('--json', 'Output JSON')
    .action(async (amountRaw: string, opts: JsonOpts) => {
      try {
        const amount = parseAmount(amountRaw, 'amount');
        const key = opts.idempotencyKey ?? randomUUID();
        const data = await new NyxClient().post<Record<string, unknown>>(
          '/api/credits/spend',
          {
            idempotencyKey: key,
            agentId: resolveAgent(opts.agent),
            amount,
            taskType: opts.taskType,
            memo: opts.memo,
          },
          { 'Idempotency-Key': key },
        );
        emit(data, opts, `Spent ${amount} credits.`);
      } catch (err) {
        fail(err, opts);
      }
    });

  // ── nyx credits usage ─────────────────────────────────
  credits
    .command('usage')
    .description('Show credit cost breakdown per task type')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { format: OutputFormat }) => {
      try {
        const client = new NyxClient();
        const data = await client.get<CostsResponse>('/api/credits/costs');

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        const rows = Object.entries(data.costs).map(([task, cost]) => ({
          task: task.replace(/_/g, ' '),
          credits: cost,
        }));

        console.log('');
        console.log(
          formatTable(rows, [
            { key: 'task', label: 'Task Type', width: 40 },
            { key: 'credits', label: 'Credits', width: 10 },
          ]),
        );
        console.log('');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx credits history ───────────────────────────────
  credits
    .command('history')
    .description('List credit transactions')
    .option('--limit <n>', 'Number of transactions to show', '20')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { limit: string; format: OutputFormat }) => {
      try {
        const client = new NyxClient();
        const limit = parseInt(opts.limit, 10) || 20;
        const data = await client.get<TransactionsResponse>(
          `/api/credits/transactions?limit=${limit}`,
        );

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        if (data.transactions.length === 0) {
          console.log('');
          console.log('  No credit transactions found.');
          console.log('');
          return;
        }

        console.log('');
        console.log(
          formatTable(data.transactions, [
            {
              key: 'createdAt',
              label: 'When',
              width: 12,
              transform: (v) => timeAgo(String(v)),
            },
            { key: 'type', label: 'Type', width: 14 },
            {
              key: 'amount',
              label: 'Amount',
              width: 10,
              transform: (v) => {
                const n = Number(v);
                return n > 0 ? `+${n}` : String(n);
              },
            },
            { key: 'description', label: 'Description', width: 50 },
          ]),
        );
        console.log('');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
