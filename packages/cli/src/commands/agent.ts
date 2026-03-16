import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

interface AgentSession {
  id: string;
  status: string;
  [key: string]: unknown;
}

export function registerAgentCommand(program: Command): void {
  const agent = program.command('agent').description('Agent activity dashboard');

  agent
    .command('sessions')
    .description('List agent sessions for a team')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--status <status>', 'Filter by session status (client-side)')
    .option('--limit <n>', 'Limit results')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId: string;
      status?: string;
      limit?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      const params = new URLSearchParams({ teamId: opts.teamId });
      if (opts.limit) params.set('limit', opts.limit);

      try {
        let data = await client.get<AgentSession[]>(`/api/agent/sessions?${params}`);

        // Filter by status client-side since the API doesn't support it
        if (opts.status) {
          data = data.filter((s) => s.status === opts.status);
        }

        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  agent
    .command('workflows')
    .description('List available agent workflows')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get('/api/agent/workflows');
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
