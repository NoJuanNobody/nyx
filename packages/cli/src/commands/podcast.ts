import { Command } from 'commander';
import { apiRequest } from '../lib/api.js';

interface PodcastScriptResponse {
  id: string;
  teamId: string;
  title: string;
  documentIds: string[];
  script: Array<{ speaker: 'Host A' | 'Host B'; text: string }>;
  qualityScore: number;
  suggestions: string[];
  createdAt: string;
}

interface PodcastListResponse {
  scripts: PodcastScriptResponse[];
}

function formatTable(scripts: PodcastScriptResponse[]): string {
  if (scripts.length === 0) return 'No podcast scripts found.';

  const header = ['ID', 'Title', 'Docs', 'Quality', 'Created'];
  const rows = scripts.map((s) => [
    s.id,
    s.title.slice(0, 40),
    s.documentIds.length.toString(),
    `${s.qualityScore}/10`,
    new Date(s.createdAt).toLocaleDateString(),
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const sep = widths.map((w) => '-'.repeat(w)).join(' | ');
  const formatRow = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join(' | ');

  return [formatRow(header), sep, ...rows.map(formatRow)].join('\n');
}

function formatScriptOutput(
  script: PodcastScriptResponse,
  format: string,
): string {
  if (format === 'json') {
    return JSON.stringify(script, null, 2);
  }

  const lines: string[] = [
    `Podcast: ${script.title}`,
    `ID: ${script.id}`,
    `Quality Score: ${script.qualityScore}/10`,
    `Documents: ${script.documentIds.join(', ')}`,
    '',
    '--- Script ---',
    '',
  ];

  for (const entry of script.script) {
    lines.push(`[${entry.speaker}]: ${entry.text}`);
  }

  if (script.suggestions.length > 0) {
    lines.push('', '--- Suggestions ---', '');
    for (const s of script.suggestions) {
      lines.push(`  - ${s}`);
    }
  }

  return lines.join('\n');
}

export function registerPodcastCommand(program: Command): void {
  const podcast = program
    .command('podcast')
    .description('Generate and manage podcast scripts from documentation');

  podcast
    .command('generate')
    .description('Generate a podcast script from one or more documents')
    .argument('<doc-ids...>', 'Document IDs to include')
    .requiredOption('--team-id <id>', 'Team ID')
    .option('--title <title>', 'Podcast episode title')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (docIds: string[], opts: { teamId: string; title?: string; format: string }) => {
      try {
        const result = await apiRequest<PodcastScriptResponse>(
          '/api/podcast/generate',
          {
            method: 'POST',
            body: JSON.stringify({
              documentIds: docIds,
              teamId: opts.teamId,
              title: opts.title,
            }),
          },
        );

        console.log(formatScriptOutput(result, opts.format));
      } catch (err) {
        console.error(
          'Error:',
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  podcast
    .command('list')
    .description('List generated podcast scripts')
    .requiredOption('--team-id <id>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { teamId: string; format: string }) => {
      try {
        const result = await apiRequest<PodcastListResponse>(
          `/api/podcast/scripts?teamId=${encodeURIComponent(opts.teamId)}`,
        );

        if (opts.format === 'json') {
          console.log(JSON.stringify(result.scripts, null, 2));
        } else {
          console.log(formatTable(result.scripts));
        }
      } catch (err) {
        console.error(
          'Error:',
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });
}
