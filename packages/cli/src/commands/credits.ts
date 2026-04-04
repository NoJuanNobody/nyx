import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

interface BalanceResponse {
  balance: number;
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

export function registerCreditsCommand(program: Command): void {
  const credits = program.command('credits').description('Manage and view credit balance and usage');

  // ── nyx credits balance ───────────────────────────────
  credits
    .command('balance')
    .description('Show current credit balance')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { format: OutputFormat }) => {
      try {
        const client = new NyxClient();
        const data = await client.get<BalanceResponse>('/api/credits/balance');

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        console.log('');
        console.log(`  Credit Balance: ${data.balance}`);
        console.log('');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
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
