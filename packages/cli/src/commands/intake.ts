import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

interface IntakeSpec {
  title: string;
  userStory: string;
  acceptanceCriteria: string[];
  edgeCases: string[];
  openQuestions: string[];
  confidence: string;
  markdown: string;
}

interface IntakeSession {
  id: string;
  rawInput: string;
  structuredOutput: IntakeSpec;
  status: string;
  documentId: string | null;
  createdAt: string;
}

interface IntakeResponse {
  session: IntakeSession;
  spec: IntakeSpec;
}

interface IntakeHistory {
  sessions: IntakeSession[];
}

export function registerIntakeCommand(program: Command): void {
  const intake = program.command('intake').description('Transform raw ideas into structured specs');

  intake
    .command('process')
    .description('Turn raw input into a structured spec')
    .option('--team-id <teamId>', 'Team ID')
    .option('--input <text>', 'Raw input text')
    .option('--stdin', 'Read input from stdin')
    .option('--save', 'Save as a new document')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (opts: {
      teamId?: string;
      input?: string;
      stdin?: boolean;
      save?: boolean;
      format: string;
    }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();

      let rawInput = opts.input;
      if (opts.stdin || !rawInput) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        rawInput = Buffer.concat(chunks).toString('utf-8').trim();
      }

      if (!rawInput) {
        error('No input provided. Use --input "text" or pipe via stdin');
      }

      try {
        console.log('  Processing intake...\n');
        const data = await client.post<IntakeResponse>('/api/intake/process', {
          rawInput,
          teamId,
        });

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        const spec = data.spec;
        const lines: string[] = [];
        lines.push(`  Title:       ${spec.title}`);
        lines.push(`  Confidence:  ${spec.confidence}`);
        lines.push(`  Session:     ${data.session.id}`);
        lines.push('');
        lines.push('  User Story:');
        lines.push(`    ${spec.userStory}`);
        lines.push('');
        lines.push('  Acceptance Criteria:');
        spec.acceptanceCriteria.forEach((c) => lines.push(`    ${c}`));
        lines.push('');
        lines.push('  Edge Cases:');
        spec.edgeCases.forEach((e) => lines.push(`    - ${e}`));
        lines.push('');
        lines.push('  Open Questions:');
        spec.openQuestions.forEach((q) => lines.push(`    ? ${q}`));
        console.log(lines.join('\n'));

        if (opts.save) {
          console.log('\n  Saving as document...');
          const doc = await client.post<Record<string, unknown>>('/api/documents', {
            teamId,
            title: spec.title,
            content: spec.markdown,
            stage: 'conception',
          });
          console.log(`  Saved: ${doc.id}`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  intake
    .command('history')
    .description('List past intake sessions')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { teamId?: string; format: OutputFormat }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();

      try {
        const data = await client.get<IntakeHistory>(`/api/intake/history?teamId=${teamId}`);
        const sessions = data.sessions ?? [];
        if (opts.format === 'json') {
          console.log(formatOutput(sessions, 'json'));
        } else if (sessions.length === 0) {
          console.log('(no intake sessions)');
        } else {
          console.log(formatTable(sessions, [
            { key: 'structuredOutput', label: 'Title', width: 50, transform: (v) => {
              const o = v as IntakeSpec | null;
              return o?.title ?? '(untitled)';
            }},
            { key: 'structuredOutput', label: 'Confidence', width: 12, transform: (v) => {
              const o = v as IntakeSpec | null;
              return o?.confidence ?? '';
            }},
            { key: 'status', label: 'Status', width: 12 },
            { key: 'createdAt', label: 'Created', transform: (v) => timeAgo(String(v)) },
            { key: 'id', label: 'ID', width: 36 },
          ]));
          console.log(`\n${sessions.length} session(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
