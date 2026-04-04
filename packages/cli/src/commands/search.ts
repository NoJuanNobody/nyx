import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, formatTable, error, type OutputFormat } from '../utils/output.js';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResponse {
  results: SearchResult[];
}

interface ContextMatch {
  docId: string;
  title: string;
  score: number;
  excerpt: string;
}

interface ContextResponse {
  relatedSpecs: ContextMatch[];
  signals: string[];
}

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Search for information via the Nyx API')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (query: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const data = await client.post<SearchResponse>('/api/search', { query });
        const results = data.results ?? [];

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        if (results.length === 0) {
          console.log('  No results found.');
          return;
        }

        console.log(formatTable(results, [
          { key: 'title', label: 'Title', width: 50 },
          { key: 'url', label: 'URL', width: 60 },
          { key: 'snippet', label: 'Snippet', width: 80 },
        ]));
        console.log(`\n${results.length} result(s)`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}

export function registerContextCommand(program: Command): void {
  program
    .command('context <doc-id>')
    .description('Find related specs and signals for a document')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (docId: string, opts: { teamId?: string; format: string }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();

      try {
        // Fetch the document content first
        const doc = await client.get<Record<string, unknown>>(`/api/documents/${docId}`);
        const docContent = String(doc.content ?? '');

        if (!docContent) {
          error('Document has no content to match against');
        }

        console.log(`  Finding context for: ${doc.title ?? docId}\n`);

        const data = await client.post<ContextResponse>('/api/intake/context', {
          rawInput: docContent,
          teamId,
        });

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        const specs = data.relatedSpecs ?? [];
        const signals = data.signals ?? [];

        if (specs.length > 0) {
          console.log('  Related Specs:');
          console.log(formatTable(specs, [
            { key: 'title', label: 'Title', width: 50 },
            {
              key: 'score',
              label: 'Score',
              width: 8,
              transform: (v) => {
                const n = Number(v);
                return isNaN(n) ? String(v) : n.toFixed(2);
              },
            },
            { key: 'excerpt', label: 'Excerpt', width: 60 },
            { key: 'docId', label: 'Doc ID', width: 36 },
          ]));
          console.log(`\n  ${specs.length} related spec(s)`);
        } else {
          console.log('  No related specs found.');
        }

        if (signals.length > 0) {
          console.log('\n  Signals:');
          signals.forEach((s) => console.log(`    - ${s}`));
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
