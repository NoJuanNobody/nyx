import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

export function registerProposalsCommand(program: Command): void {
  const proposals = program
    .command('proposals')
    .description('Manage stakeholder change proposals');

  proposals
    .command('list <doc-id>')
    .description('List change proposals for a document')
    .option('--status <status>', 'Filter by status')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (docId: string, opts: { status?: string; format: OutputFormat }) => {
      const client = new NyxClient();
      const params = new URLSearchParams();
      if (opts.status) params.set('status', opts.status);
      const qs = params.toString();
      const path = `/api/documents/${docId}/change-proposals${qs ? `?${qs}` : ''}`;

      try {
        const data = await client.get<Record<string, unknown>[]>(path);
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else if (!Array.isArray(data) || data.length === 0) {
          console.log('(no proposals)');
        } else {
          console.log(formatTable(data, [
            { key: 'id', label: 'ID', width: 36 },
            { key: 'status', width: 12 },
            { key: 'summary', width: 50 },
            { key: 'createdAt', label: 'Created', transform: (v) => timeAgo(String(v)) },
          ]));
          console.log(`\n${data.length} proposal(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  proposals
    .command('generate <doc-id>')
    .description('Generate a new change proposal from a document')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (docId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.post(`/api/documents/${docId}/change-proposals/generate`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  proposals
    .command('approve <proposal-id>')
    .description('Approve a change proposal')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (proposalId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.patch(`/api/change-proposals/${proposalId}/approve`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  proposals
    .command('reject <proposal-id>')
    .description('Reject a change proposal')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (proposalId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.patch(`/api/change-proposals/${proposalId}/reject`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  proposals
    .command('push <proposal-id>')
    .description('Push an approved proposal (creates tickets)')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (proposalId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.post(`/api/change-proposals/${proposalId}/push`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
