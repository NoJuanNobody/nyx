import type { Command } from 'commander';
import { apiGet } from '../lib/api-client.js';

interface DocChange {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
  stage: string | null;
}

interface ChangesResponse {
  changes: DocChange[];
  since: string;
  until: string;
}

function formatChange(change: DocChange): string {
  const stage = change.stage ? ` — stage: ${change.stage}` : '';
  return `[${change.updatedAt}] Updated: "${change.title}" (${change.id})${stage}`;
}

/**
 * Register the `nyx watch` command — continuously polls for doc changes.
 */
export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Poll for document changes in real-time')
    .requiredOption('--team-id <id>', 'Team ID to watch')
    .option('--interval <seconds>', 'Polling interval in seconds', '30')
    .option('--since <iso-date>', 'Start watching from this timestamp')
    .action(async (opts: { teamId: string; interval: string; since?: string }) => {
      const intervalMs = (parseInt(opts.interval, 10) || 30) * 1000;
      let cursor = opts.since || new Date().toISOString();

      console.log(`Watching team ${opts.teamId} for changes (interval: ${opts.interval}s)`);
      console.log(`Starting from: ${cursor}`);
      console.log('Press Ctrl+C to stop.\n');

      const poll = async () => {
        try {
          const data = await apiGet<ChangesResponse>('/api/documents/changes', {
            teamId: opts.teamId,
            since: cursor,
          });

          for (const change of data.changes.reverse()) {
            console.log(formatChange(change));
          }

          if (data.changes.length > 0) {
            cursor = data.until;
          }
        } catch (err) {
          console.error(`Poll error: ${(err as Error).message}`);
        }
      };

      // Initial poll
      await poll();

      // Set up interval
      const timer = setInterval(poll, intervalMs);

      // Graceful shutdown
      const cleanup = () => {
        clearInterval(timer);
        console.log('\nStopped watching.');
        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    });
}

/**
 * Register the `nyx changes` command — one-shot fetch of recent changes.
 */
export function registerChangesCommand(program: Command): void {
  program
    .command('changes')
    .description('List recent document changes (one-shot)')
    .requiredOption('--team-id <id>', 'Team ID')
    .option('--since <iso-date>', 'Show changes since this timestamp (default: 24h ago)')
    .option('--limit <n>', 'Maximum number of changes to return', '50')
    .option('--format <format>', 'Output format: table or json', 'table')
    .action(async (opts: { teamId: string; since?: string; limit: string; format: string }) => {
      const since = opts.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      try {
        const data = await apiGet<ChangesResponse>('/api/documents/changes', {
          teamId: opts.teamId,
          since,
          limit: opts.limit,
        });

        if (opts.format === 'json') {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        // Table format
        if (data.changes.length === 0) {
          console.log('No changes found since', since);
          return;
        }

        console.log(`${data.changes.length} change(s) since ${data.since}:\n`);
        for (const change of data.changes) {
          console.log(formatChange(change));
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
