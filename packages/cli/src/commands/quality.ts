import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function registerQualityCommand(program: Command): void {
  const quality = program.command('quality').description('AI quality assessment');

  quality
    .command('check [doc-id]')
    .description('Run AI quality analysis on a document')
    .option('--stdin', 'Read content from stdin instead of fetching a document')
    .option('--threshold <n>', 'Minimum score threshold (exit 1 if below)', '7')
    .option('--stage <stage>', 'Lifecycle stage for analysis context')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(async (docId: string | undefined, opts: {
      stdin?: boolean;
      threshold: string;
      stage?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      let content: string;

      try {
        if (opts.stdin) {
          content = await readStdin();
          if (!content.trim()) {
            error('No content received from stdin');
          }
        } else if (docId) {
          const doc = await client.get<{ content: string }>(`/api/documents/${docId}`);
          content = doc.content;
        } else {
          error('Provide a <doc-id> or use --stdin to pipe content');
        }

        const body: { content: string; stage?: string } = { content };
        if (opts.stage) {
          body.stage = opts.stage;
        }

        const result = await client.post<{ score: number; suggestions?: string[]; [key: string]: unknown }>('/api/ai/analyze', body);
        if (opts.format === 'json') {
          console.log(formatOutput(result, 'json'));
        } else {
          const lines = [
            `  Quality Score: ${result.score}/10`,
          ];
          if (result.suggestions && result.suggestions.length > 0) {
            lines.push('');
            lines.push('  Suggestions:');
            result.suggestions.forEach((s, i) => {
              lines.push(`    ${i + 1}. ${s}`);
            });
          }
          console.log(lines.join('\n'));
        }

        const threshold = parseInt(opts.threshold, 10);
        if (result.score < threshold) {
          process.exit(1);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  quality
    .command('improve <doc-id>')
    .description('AI-improve a document based on quality suggestions')
    .option('--instruction <text>', 'Custom improvement instruction')
    .option('--apply', 'Apply the improved content back to the document')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (docId: string, opts: {
      instruction?: string;
      apply?: boolean;
      format: string;
    }) => {
      const client = new NyxClient();

      try {
        // Fetch current doc
        const doc = await client.get<{ content: string; title: string; stage?: string }>(`/api/documents/${docId}`);

        // Get quality suggestions first
        process.stderr.write('  Analyzing current quality...\n');
        const analysis = await client.post<{ score: number; suggestions?: string[] }>('/api/ai/analyze', {
          content: doc.content,
          stage: doc.stage,
        });

        const currentScore = analysis.score;
        process.stderr.write(`  Current score: ${currentScore}/10\n\n`);

        // Build improvement instruction
        const instruction = opts.instruction ??
          `Improve this spec to production quality. Address these issues:\n${(analysis.suggestions ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`;

        process.stderr.write('  Generating improved version...\n\n');
        const improved = await client.post<{ content: string }>('/api/ai/edit-document', {
          content: doc.content,
          instruction,
        });

        if (opts.format === 'json') {
          console.log(JSON.stringify({ currentScore, improved: improved.content }, null, 2));
          return;
        }

        if (opts.apply) {
          await client.put(`/api/documents/${docId}`, {
            content: improved.content,
          });

          // Re-score
          const newAnalysis = await client.post<{ score: number }>('/api/ai/analyze', {
            content: improved.content,
            stage: doc.stage,
          });

          console.log(`  Before: ${currentScore}/10`);
          console.log(`  After:  ${newAnalysis.score}/10`);
          console.log(`\n  Document updated: ${docId}`);
        } else {
          console.log(improved.content);
          console.log(`\n  ─────────────────────────────────`);
          console.log(`  Preview only. Use --apply to save.`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
