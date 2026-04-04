import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatTable, formatOutput, error, type OutputFormat } from '../utils/output.js';

interface Plan {
  id: string;
  name: string;
  price: number | null;
  interval: string | null;
  features: string[];
}

interface Subscription {
  id: string | null;
  teamId: string;
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

interface PortalResponse {
  url: string;
}

export function registerBillingCommand(program: Command): void {
  const billing = program.command('billing').description('Billing and subscription management');

  // ── nyx billing plans ──────────────────────────────────
  billing
    .command('plans')
    .description('List available plans')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const plans = await client.get<Plan[]>('/api/subscriptions/plans');

        if (opts.format === 'json') {
          console.log(formatOutput(plans, 'json'));
          return;
        }

        const table = formatTable(plans, [
          { key: 'name', label: 'Plan', width: 12 },
          {
            key: 'price',
            label: 'Price',
            width: 14,
            transform: (val) => {
              if (val === null || val === 0) return val === 0 ? 'Free' : 'Contact us';
              return `$${val}/mo`;
            },
          },
          {
            key: 'features',
            label: 'Features',
            width: 60,
            transform: (val) => {
              if (Array.isArray(val)) return val.join(', ');
              return String(val ?? '');
            },
          },
        ]);

        console.log('');
        console.log('  Available Plans');
        console.log('');
        console.log(table);
        console.log('');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx billing current ────────────────────────────────
  billing
    .command('current')
    .description('Show current subscription')
    .option('--team-id <id>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { teamId?: string; format: OutputFormat }) => {
      const client = new NyxClient();
      const teamId = resolveTeamId(opts.teamId);

      try {
        const params = new URLSearchParams({ teamId });
        const sub = await client.get<Subscription>(
          `/api/subscriptions/current?${params}`,
        );

        if (opts.format === 'json') {
          console.log(formatOutput(sub, 'json'));
          return;
        }

        const check = '\u2713';
        const cross = '\u2717';
        const line = '\u2500'.repeat(30);

        console.log('');
        console.log('  Current Subscription');
        console.log(`  ${line}`);
        console.log(`  Plan:       ${sub.plan}`);
        console.log(`  Status:     ${sub.status === 'active' ? check : cross} ${sub.status}`);

        if (sub.currentPeriodEnd) {
          console.log(
            `  Renews:     ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`,
          );
        }

        if (sub.cancelAtPeriodEnd) {
          console.log('  Note:       Cancels at end of billing period');
        }

        console.log('');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx billing portal ─────────────────────────────────
  billing
    .command('portal')
    .description('Get Stripe billing portal URL')
    .option('--team-id <id>', 'Team ID')
    .option('--return-url <url>', 'URL to return to after portal session', 'https://app.nyx.dev')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(
      async (opts: { teamId?: string; returnUrl: string; format: OutputFormat }) => {
        const client = new NyxClient();
        const teamId = resolveTeamId(opts.teamId);

        try {
          const result = await client.post<PortalResponse>('/api/billing/portal', {
            teamId,
            returnUrl: opts.returnUrl,
          });

          if (opts.format === 'json') {
            console.log(formatOutput(result, 'json'));
            return;
          }

          console.log('');
          console.log('  Billing Portal');
          console.log(`  ${'─'.repeat(30)}`);
          console.log(`  URL: ${result.url}`);
          console.log('');
          console.log('  Open this URL in your browser to manage your subscription.');
          console.log('');
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );
}
