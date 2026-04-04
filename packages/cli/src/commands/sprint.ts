import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

export function registerSprintCommand(program: Command): void {
  const sprint = program.command('sprint').description('Sprint gatekeeper commands');

  sprint
    .command('status')
    .description('Show sprint capacity for a team')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(async (opts: { teamId?: string; format: OutputFormat }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      try {
        const data = await client.get<{
          sprintName?: string;
          totalWeight?: number;
          usedWeight?: number;
          capacityPercent?: number;
          totalPoints?: number;
          usedPoints?: number;
          tickets?: unknown[];
        }>(`/api/sprint/capacity?teamId=${teamId}`);
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          const lines = [
            `  Sprint:    ${data.sprintName ?? 'No Sprint'}`,
            `  Capacity:  ${data.capacityPercent ?? 0}% (${data.usedWeight ?? 0} / ${data.totalWeight ?? 0} weight)`,
            `  Points:    ${data.usedPoints ?? 0} / ${data.totalPoints ?? 0}`,
            `  Tickets:   ${data.tickets?.length ?? 0}`,
          ];
          console.log(lines.join('\n'));
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  sprint
    .command('check')
    .description('Check if a new ticket fits in the current sprint')
    .option('--team-id <teamId>', 'Team ID')
    .option('--weight <n>', 'Weight of the new ticket')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: { teamId?: string; weight?: string; format: OutputFormat }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      try {
        const body: Record<string, unknown> = { teamId };
        if (opts.weight !== undefined) {
          body.newTicketWeight = Number(opts.weight);
        }
        const data = await client.post('/api/sprint/check', body);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  sprint
    .command('defer <ticketId>')
    .description('Defer a ticket to the next sprint')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (ticketId: string, opts: { teamId?: string; format: OutputFormat }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      try {
        const data = await client.post('/api/sprint/defer', {
          teamId,
          ticketKey: ticketId,
        });
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  sprint
    .command('weight <docId>')
    .description('Estimate decision weight for a document')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (docId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const doc = await client.get<{ content?: string; stage?: string }>(`/api/documents/${docId}`);
        const data = await client.post('/api/ai/decision-weight', {
          content: doc.content,
          stage: doc.stage,
        });
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
