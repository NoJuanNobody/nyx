import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatTable, timeAgo, formatOutput, error, type OutputFormat } from '../utils/output.js';

interface TicketSuggestion {
  id: string;
  title: string;
  description: string;
  status: string;
  labels: string[];
  createdAt: string;
}

interface Ticket {
  id: string;
  title: string;
  status: string;
  provider: string;
  externalUrl?: string;
  createdAt: string;
  updatedAt?: string;
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

  tickets
    .command('list-all')
    .description('List all team tickets')
    .option('--team-id <id>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { teamId?: string; format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const teamId = resolveTeamId(opts.teamId);
        const data = await client.get<Ticket[]>(
          `/api/tickets?teamId=${encodeURIComponent(teamId)}`,
        );

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        if (!data.length) {
          console.log('(no tickets)');
          return;
        }

        console.log(formatTable(data, [
          { key: 'id', label: 'ID', width: 20 },
          { key: 'title', label: 'Title', width: 50 },
          { key: 'status', label: 'Status', width: 12 },
          { key: 'provider', label: 'Provider', width: 10 },
          { key: 'createdAt', label: 'Created', transform: (v) => timeAgo(String(v)) },
        ]));
        console.log(`\n${data.length} ticket(s)`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  tickets
    .command('create <doc-id>')
    .description('Create a ticket from a document')
    .requiredOption('--provider <provider>', 'Ticket provider (e.g. github, jira)')
    .requiredOption('--title <title>', 'Ticket title')
    .option('--body <body>', 'Ticket body/description', '')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(
      async (
        docId: string,
        opts: { provider: string; title: string; body: string; format: string },
      ) => {
        const client = new NyxClient();

        try {
          const ticket = await client.post<Ticket>(
            `/api/documents/${docId}/tickets`,
            {
              provider: opts.provider,
              title: opts.title,
              body: opts.body,
            },
          );

          if (opts.format === 'json') {
            console.log(formatOutput(ticket, 'json'));
            return;
          }

          console.log(`  Ticket created successfully.`);
          console.log(`  ID:       ${ticket.id}`);
          console.log(`  Title:    ${ticket.title}`);
          console.log(`  Provider: ${ticket.provider}`);
          console.log(`  Status:   ${ticket.status}`);
          if (ticket.externalUrl) {
            console.log(`  URL:      ${ticket.externalUrl}`);
          }
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );

  tickets
    .command('sync')
    .description('Sync all team tickets with external providers')
    .option('--team-id <id>', 'Team ID')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (opts: { teamId?: string; format: string }) => {
      const client = new NyxClient();

      try {
        const teamId = resolveTeamId(opts.teamId);

        if (opts.format !== 'json') {
          process.stderr.write('  Syncing tickets...\n\n');
        }

        const result = await client.post<{ synced: number; errors: number }>(
          `/api/tickets/sync-all?teamId=${encodeURIComponent(teamId)}`,
          {},
        );

        if (opts.format === 'json') {
          console.log(formatOutput(result, 'json'));
          return;
        }

        console.log(`  Sync complete: ${result.synced} synced, ${result.errors} error(s)`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  tickets
    .command('status <ticket-id>')
    .description('Update the status of a ticket')
    .requiredOption('--status <status>', 'New status (open|in_progress|closed)')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(
      async (ticketId: string, opts: { status: string; format: string }) => {
        const client = new NyxClient();

        try {
          const validStatuses = ['open', 'in_progress', 'closed'];
          if (!validStatuses.includes(opts.status)) {
            error(`Invalid status "${opts.status}". Must be one of: ${validStatuses.join(', ')}`);
          }

          const ticket = await client.patch<Ticket>(
            `/api/tickets/${ticketId}/status`,
            { status: opts.status },
          );

          if (opts.format === 'json') {
            console.log(formatOutput(ticket, 'json'));
            return;
          }

          console.log(`  Ticket ${ticket.id} updated to "${ticket.status}".`);
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );
}
