import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

export function registerAuditCommand(program: Command): void {
  const audit = program
    .command('audit <doc-id>')
    .description('Get audit trail for a document')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (docId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const response = await client.get<{ documentId: string; events: Record<string, unknown>[] }>(`/api/documents/${docId}/audit-trail`);
        const data = response.events;
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(formatTable(data, [
            { key: 'eventType', label: 'Event', width: 20 },
            { key: 'actorName', label: 'Actor', width: 25 },
            { key: 'metadata', width: 40, transform: (v) => JSON.stringify(v) },
            { key: 'createdAt', label: 'When', transform: (v) => timeAgo(String(v)) },
          ]));
          console.log(`\n${data.length} event(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  audit
    .command('trace <event-id>')
    .description('Get full trace chain for an audit event')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (eventId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(`/api/audit-trail/${eventId}/trace`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}

export function registerActivityCommand(program: Command): void {
  program
    .command('activity')
    .description('Get team activity feed')
    .option('--team-id <teamId>', 'Team ID')
    .option('--limit <n>', 'Limit results')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: {
      teamId?: string;
      limit?: string;
      format: OutputFormat;
    }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      const params = new URLSearchParams();
      if (opts.limit) params.set('limit', opts.limit);
      const query = params.toString();
      const url = `/api/teams/${teamId}/activity${query ? `?${query}` : ''}`;

      try {
        const response = await client.get<{ teamId: string; events: Record<string, unknown>[] }>(url);
        const data = response.events;
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(formatTable(data, [
            { key: 'action', width: 20 },
            { key: 'resourceType', label: 'Resource', width: 16 },
            { key: 'userId', label: 'User', width: 36 },
            { key: 'createdAt', label: 'When', transform: (v) => timeAgo(String(v)) },
          ]));
          console.log(`\n${data.length} event(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
