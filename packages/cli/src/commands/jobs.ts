import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

interface Job {
  id: string;
  type: string;
  status: string;
  progress?: number;
  progressMessage?: string;
  error?: string;
  result?: unknown;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  [key: string]: unknown;
}

export function registerJobsCommand(program: Command): void {
  const jobs = program.command('jobs').description('Background job management');

  jobs
    .command('list')
    .description('List recent background jobs')
    .option('--team-id <teamId>', 'Team ID')
    .option('--limit <n>', 'Limit results')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { teamId?: string; limit?: string; format: OutputFormat }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      const params = new URLSearchParams();
      if (opts.limit) params.set('limit', opts.limit);
      const query = params.toString();
      const url = `/api/teams/${teamId}/jobs${query ? `?${query}` : ''}`;

      try {
        const response = await client.get<{ teamId: string; jobs: Job[] }>(url);
        const data = response.jobs;
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(
            formatTable(data, [
              { key: 'id', width: 36 },
              { key: 'type', width: 20 },
              { key: 'status', width: 12 },
              { key: 'createdAt', label: 'Started', transform: (v) => timeAgo(String(v)) },
            ]),
          );
          console.log(`\n${data.length} job(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  jobs
    .command('status <job-id>')
    .description('Show details of a specific background job')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (jobId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get<Job>(`/api/jobs/${jobId}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
