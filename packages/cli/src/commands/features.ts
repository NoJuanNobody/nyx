import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatTable, timeAgo, formatOutput, error, type OutputFormat } from '../utils/output.js';

interface FeatureRequest {
  id: string;
  title: string;
  description: string;
  status: string;
  upvoteCount: number;
  authorId: string;
  createdAt: string;
}

export function registerFeaturesCommand(program: Command): void {
  const features = program.command('features').description('Feature request management');

  features
    .command('list')
    .description('List feature requests')
    .option('--status <status>', 'Filter by status')
    .option('--sort <sort>', 'Sort order (upvotes|newest)', 'upvotes')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { status?: string; sort?: string; format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const params = new URLSearchParams();
        if (opts.status) params.set('status', opts.status);
        if (opts.sort) params.set('sort', opts.sort);
        const qs = params.toString();
        const data = await client.get<FeatureRequest[]>(
          `/api/feature-requests${qs ? `?${qs}` : ''}`,
        );

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        if (!data.length) {
          console.log('(no feature requests)');
          return;
        }

        console.log(formatTable(data, [
          { key: 'id', label: 'ID', width: 20 },
          { key: 'title', label: 'Title', width: 50 },
          { key: 'status', label: 'Status', width: 12 },
          { key: 'upvoteCount', label: 'Votes', width: 6 },
          { key: 'createdAt', label: 'Created', transform: (v) => timeAgo(String(v)) },
        ]));
        console.log(`\n${data.length} feature request(s)`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  features
    .command('submit')
    .description('Submit a new feature request')
    .requiredOption('--title <title>', 'Feature request title')
    .requiredOption('--description <description>', 'Feature request description')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (opts: { title: string; description: string; format: string }) => {
      const client = new NyxClient();

      try {
        const fr = await client.post<FeatureRequest>(
          '/api/feature-requests',
          { title: opts.title, description: opts.description },
        );

        if (opts.format === 'json') {
          console.log(formatOutput(fr, 'json'));
          return;
        }

        console.log('  Feature request submitted successfully.');
        console.log(`  ID:     ${fr.id}`);
        console.log(`  Title:  ${fr.title}`);
        console.log(`  Status: ${fr.status}`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  features
    .command('vote <id>')
    .description('Toggle upvote on a feature request')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (id: string, opts: { format: string }) => {
      const client = new NyxClient();

      try {
        const result = await client.post<{ upvoted: boolean }>(
          `/api/feature-requests/${id}/upvote`,
          {},
        );

        if (opts.format === 'json') {
          console.log(formatOutput(result, 'json'));
          return;
        }

        if (result.upvoted) {
          console.log(`  Upvoted feature request ${id}.`);
        } else {
          console.log(`  Removed upvote from feature request ${id}.`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
