import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

export function registerTimelineCommand(program: Command): void {
  program
    .command('timeline <doc-id>')
    .description('Get timeline events for a document')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (docId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const response = await client.get<{ documentId: string; events: Record<string, unknown>[] }>(
          `/api/documents/${docId}/timeline`,
        );
        const data = response.events;
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(formatTable(data, [
            { key: 'eventType', label: 'Event', width: 24 },
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
}
