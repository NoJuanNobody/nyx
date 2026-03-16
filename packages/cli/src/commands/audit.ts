import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

export function registerAuditCommand(program: Command): void {
  const audit = program
    .command('audit <doc-id>')
    .description('Get audit trail for a document')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (docId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(`/api/documents/${docId}/audit-trail`);
        console.log(formatOutput(data, opts.format));
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
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--limit <n>', 'Limit results')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId: string;
      limit?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      const params = new URLSearchParams();
      if (opts.limit) params.set('limit', opts.limit);
      const query = params.toString();
      const url = `/api/teams/${opts.teamId}/activity${query ? `?${query}` : ''}`;

      try {
        const data = await client.get(url);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
