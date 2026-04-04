import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

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
    .option('--team-id <teamId>', 'Team ID')
    .option('--status <status>', 'Filter by session status (client-side)')
    .option('--limit <n>', 'Limit results')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: {
      teamId?: string;
      status?: string;
      limit?: string;
      format: OutputFormat;
    }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      const params = new URLSearchParams({ teamId });
      if (opts.limit) params.set('limit', opts.limit);

      try {
        let data = await client.get<AgentSession[]>(`/api/agent/sessions?${params}`);

        // Filter by status client-side since the API doesn't support it
        if (opts.status) {
          data = data.filter((s) => s.status === opts.status);
        }

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(formatTable(data, [
            { key: 'id', width: 36 },
            { key: 'status', width: 12 },
            { key: 'agentId', label: 'Agent', width: 20 },
            { key: 'createdAt', label: 'Created', transform: (v) => timeAgo(String(v)) },
          ]));
          console.log(`\n${data.length} session(s)`);
        }
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
