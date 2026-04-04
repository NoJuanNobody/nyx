import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatTable, timeAgo, formatOutput, error, type OutputFormat } from '../utils/output.js';

interface TicketSuggestion {
  id: string;
  title: string;
  description: string;
  status: string;
  labels: string[];
  createdAt: string;
}

export function registerTicketsCommand(program: Command): void {
  const tickets = program.command('tickets').description('AI-powered ticket generation from specs');

  tickets
    .command('suggest <doc-id>')
    .description('Generate ticket suggestions from a document')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (docId: string, opts: { format: string }) => {
      const client = new NyxClient();

      try {
        if (opts.format !== 'json') {
          process.stderr.write('  Generating ticket suggestions...\n\n');
        }
        const data = await client.post<TicketSuggestion>(
          `/api/documents/${docId}/suggest-tickets`,
          {},
        );

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        // The response description may contain JSON ticket array
        const desc = (data as unknown as Record<string, unknown>).description as string ?? '';
        let suggestions: Array<{ title: string; description: string; labels: string[] }> = [];
        try {
          const jsonMatch = desc.match(/```json\n([\s\S]*?)```/) ?? desc.match(/(\[[\s\S]*\])/);
          if (jsonMatch) {
            suggestions = JSON.parse(jsonMatch[1]);
          }
        } catch {
          // Fall back to showing title
        }

        if (suggestions.length > 0) {
          console.log(`  Generated ${suggestions.length} ticket(s):\n`);
          suggestions.forEach((s, i) => {
            const labels = s.labels?.length ? ` [${s.labels.join(', ')}]` : '';
            console.log(`  ${i + 1}. ${s.title}${labels}`);
          });
        } else {
          console.log(`  Title: ${data.title}`);
          console.log(`  Status: ${data.status}`);
        }

        console.log(`\n  Suggestion ID: ${data.id}`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  tickets
    .command('list <doc-id>')
    .description('List pending ticket suggestions for a document')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (docId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const data = await client.get<TicketSuggestion[]>(
          `/api/documents/${docId}/ticket-suggestions`,
        );

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        if (!data.length) {
          console.log('(no ticket suggestions)');
          return;
        }

        console.log(formatTable(data, [
          { key: 'title', label: 'Title', width: 60 },
          { key: 'status', label: 'Status', width: 10 },
          { key: 'createdAt', label: 'Created', transform: (v) => timeAgo(String(v)) },
        ]));
        console.log(`\n${data.length} suggestion(s)`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
