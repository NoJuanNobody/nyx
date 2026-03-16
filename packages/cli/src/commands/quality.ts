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
    .option('--format <format>', 'Output format (json|table)', 'json')
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

        const result = await client.post<{ score: number; [key: string]: unknown }>('/api/ai/analyze', body);
        console.log(formatOutput(result, opts.format));

        const threshold = parseInt(opts.threshold, 10);
        if (result.score < threshold) {
          process.exit(1);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
