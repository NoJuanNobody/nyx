import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

export function registerSnapshotCommand(program: Command): void {
  const snapshot = program
    .command('snapshot')
    .description('Manage document snapshots');

  snapshot
    .command('list')
    .description('List snapshots')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { teamId?: string; format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const params = new URLSearchParams();
        if (opts.teamId) params.set('teamId', opts.teamId);
        const query = params.toString();
        const url = `/api/snapshots${query ? `?${query}` : ''}`;

        const response = await client.get<{ snapshots: Record<string, unknown>[] }>(url);
        const data = response.snapshots;
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(formatTable(data, [
            { key: 'id', label: 'ID', width: 36 },
            { key: 'name', label: 'Name', width: 30 },
            { key: 'createdAt', label: 'Created', transform: (v) => timeAgo(String(v)) },
          ]));
          console.log(`\n${data.length} snapshot(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  snapshot
    .command('create')
    .description('Create a new snapshot')
    .requiredOption('--name <name>', 'Snapshot name')
    .requiredOption('--doc-ids <ids>', 'Comma-separated document IDs')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: { name: string; docIds: string; format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const documentIds = opts.docIds.split(',').map((id) => id.trim());
        const response = await client.post<{ snapshots: unknown }>('/api/snapshots', {
          name: opts.name,
          documentIds,
        });
        console.log(formatOutput(response.snapshots, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  snapshot
    .command('get <id>')
    .description('Get a snapshot by ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (id: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(`/api/snapshots/${id}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  snapshot
    .command('restore <id>')
    .description('Restore a document from a snapshot')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (id: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.post(`/api/snapshots/${id}/restore`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
